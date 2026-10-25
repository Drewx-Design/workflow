import { canonicalJsonSha256, sha256Bytes } from "../../lib/github-issue-roadmap/canonical-json";
import { stewardshipPacketMaterialSha256, type StewardshipIssueEvidencePacket } from "../../lib/github-issue-roadmap/stewardship-evidence";
import { knownStewardshipPolicy, stewardshipPolicySha256 } from "../../lib/github-issue-roadmap/stewardship-policy";
import { ISSUE_SNAPSHOT_SCHEMA, qualifyIssueIdentity, qualifyRepositoryIdentity, verificationFreshness } from "../../lib/github-issue-roadmap/snapshot-v2";
import type { StewardshipAssessment } from "../../lib/github-issue-roadmap/stewardship-assessment";

// Legacy decision/replay fixtures retain v2 authority; snapshot tests explicitly request v3.
export const policy = knownStewardshipPolicy("v2", { repository: "example-org/example-repo", operator: "operator" });
export const main = "a".repeat(40);
export const now = "2026-09-23T12:00:00Z";
export function evidenceFixture() {
  const repository = qualifyRepositoryIdentity({ organization: "example-org", name: "example-repo", databaseId: 1, nodeId: "R_1" });
  const body = "## Completion\nReturn a bounded result from src/current.ts.";
  const text = "export function current() { return null; }\n";
  const hash = sha256Bytes(text);
  const source = { evidenceId: `source:${hash}`, path: "src/current.ts", blobOid: "b".repeat(40), contentSha256: hash,
    snippetSha256: hash, byteLength: Buffer.byteLength(text), fullByteLength: Buffer.byteLength(text), text };
  const frontier = { complete: true, eventIds: [], cursor: null };
  const relationships = { parent: null, subIssues: [], blockedBy: [], blocking: [] };
  const packet: StewardshipIssueEvidencePacket = {
    evidencePhase: "initial", issueNumber: 1, title: "Bound the result", body, bodySha256: sha256Bytes(body), fields: { Priority: "P2", Horizon: "Later" },
    issue: { schemaVersion: ISSUE_SNAPSHOT_SCHEMA, identity: qualifyIssueIdentity(repository, { number: 1, databaseId: 11, nodeId: "I_1", repositoryFullName: policy.repository }),
      v1: { number: 1, title: "Bound the result", state: "OPEN", stateReason: null, type: null,
        fieldValues: [{ name: "Priority", value: "P2", field: { name: "Priority" } }, { name: "Horizon", value: "Later", field: { name: "Horizon" } }],
        labels: [], assignees: [], milestone: null, bodySha256: sha256Bytes(body), createdAt: now, updatedAt: now, relationships },
      nativeType: null, relationships, projectMemberships: [], persistedVerifications: [], pullRequests: [], freshness: verificationFreshness([], now, main), transport: [] },
    fieldHistory: { Priority: { frontier, events: [], sha256: canonicalJsonSha256([]) }, Horizon: { frontier, events: [], sha256: canonicalJsonSha256([]) } },
    sources: [source], clauses: [{ clauseId: "clause:1:1", text: "Return a bounded result.", coverage: "source_collected", evidenceIds: [source.evidenceId] }],
    facts: [{ factId: `fact:${canonicalJsonSha256({ kind: "source", locator: source.path })}`, kind: "source", locator: source.path,
      contentSha256: canonicalJsonSha256({ path: source.path, contentSha256: hash }), evidenceIds: [source.evidenceId] }],
    coverage: { sourceComplete: true, fieldHistoryComplete: true, requestedPaths: [source.path], explicitSourcePaths: [], rejectedPaths: [], omittedPaths: [], sourceBytes: source.byteLength },
    materialEvidenceSha256: "",
  };
  return rebind({ packet, originMainSha: main, policySha256: stewardshipPolicySha256(policy) });
}
export function rebind<T extends ReturnTypeShape>(evidence: T): T {
  return { ...evidence, packet: { ...evidence.packet, materialEvidenceSha256: stewardshipPacketMaterialSha256(evidence.packet, evidence.originMainSha, evidence.policySha256) } };
}
interface ReturnTypeShape { packet: StewardshipIssueEvidencePacket; originMainSha: string; policySha256: string }

export function assessmentFixture(evidence = evidenceFixture()): StewardshipAssessment {
  const id = (evidence.packet.sources.find((source) => source.path === "src/current.ts") ?? evidence.packet.sources[0]).evidenceId;
  const claim = { statement: "The current implementation returns null, leaving the bounded result unfulfilled.", evidenceIds: [id] };
  return {
    binding: { issueNumber: 1, packetSha256: canonicalJsonSha256(evidence.packet), materialEvidenceSha256: evidence.packet.materialEvidenceSha256,
      originMainSha: evidence.originMainSha, policySha256: evidence.policySha256, rubric: policy.rubric },
    proposed: { Priority: "P3" as const, Horizon: "Later" as const }, rationale: "A closeable cleanup with limited deferral cost.",
    evidenceIds: [id], counterevidenceIds: [], blockers: [], unresolvedChoices: [],
    premise: "supported" as const, completion: "unfulfilled" as const, independentlyCloseable: true,
    sequencing: { disposition: "later" as const, statement: "After current work.", evidenceIds: [id] }, revisitTrigger: null,
    clauses: [{ clauseId: "clause:1:1", status: "unfulfilled" as const, reason: claim.statement,
      codeReferences: [{ evidenceId: id, quote: "return null;" }] }],
    rubricFacts: { reachableProduction: null, invariant: null, blastRadius: null, directProof: null, confirmingCheck: null, whyP1Unsafe: null,
      coreJourneyOrLaunchGateOrConflictingTruth: null, strategyTrack: null, impact: claim, dependencyPosition: null, remainingGap: claim, closeableOutcome: claim, worthwhile: claim },
    demotion: null, supersedesHold: null,
  };
}
