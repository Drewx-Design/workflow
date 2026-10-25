import { describe, expect, it, vi } from "vitest";
import { canonicalJsonSha256, sha256Bytes } from "../lib/github-issue-roadmap/canonical-json";
import {
  collectStewardshipEvidence,
  stewardshipPacketMaterialSha256,
  stewardshipSourceSnippetIdentity,
  type StewardshipEvidenceGeneration,
  type StewardshipEvidenceGit,
  type StewardshipIssueEvidencePacket,
} from "../lib/github-issue-roadmap/stewardship-evidence";
import {
  reuseStewardshipObservation,
  type StewardshipObservationReuseInput,
} from "../lib/github-issue-roadmap/stewardship-observation-reuse";
import { buildStewardshipProjection } from "../lib/github-issue-roadmap/stewardship-projection";
import type { StewardshipEvent, StewardshipState } from "../lib/github-issue-roadmap/stewardship-state";
import {
  ISSUE_SNAPSHOT_SCHEMA,
  qualifyIssueIdentity,
  qualifyRepositoryIdentity,
  verificationFreshness,
  type IssueSnapshotV2,
} from "../lib/github-issue-roadmap/snapshot-v2";

const main = "a".repeat(40);
const capturedAt = "2026-10-20T12:00:00Z";
const specPath = "docs/roadmap/milestone-1.md";
const runbookPath = "docs/runbooks/github-issue-roadmap.md";
const runbook = "# Roadmap\nBefore the rubric.\n\n## Priority rubric\nKeep the journey moving.\n\n## Intake\nOther guidance.\n";
const spec = ["---", "spec_version: 1", "---", "# Milestone 1", "",
  "## Rubric (versioned by `spec_version`)", "", "### Tiers", "Blockers stop the journey.", "",
  "## Tier anchors (the operator approved)", "Blocks: #1930, #1932, #1897", ""].join("\n");
const repository = qualifyRepositoryIdentity({
  organization: "example-org", name: "example-repo", databaseId: 1, nodeId: "R_repo",
});

function included(body: unknown) {
  return ["HTTP/2.0 200 OK", "x-github-request-id: REQ-test",
    "x-github-api-version-selected: 2026-03-10", "", JSON.stringify(body)].join("\r\n");
}

function censusIssue(number: number) {
  const events = (["Priority", "Horizon"] as const).map((field) => ({
    __typename: "IssueFieldChangedEvent", id: `${field}-${number}`, actor: { login: "bot" },
    createdAt: capturedAt, issueField: { id: `F_${field}`, fullDatabaseId: "456", name: field },
    previousOptions: [], newOptions: [{ name: field === "Priority" ? "P2" : "Later" }],
    previousValue: null, newValue: field === "Priority" ? "P2" : "Later",
  }));
  return {
    id: `I_${number}`, databaseId: 1_000 + number, number, title: `Issue ${number}`, body: `Body ${number}`,
    createdAt: "2026-01-01T00:00:00Z", updatedAt: capturedAt, state: "OPEN", stateReason: null,
    repository: { id: "R_repo", databaseId: 1, nameWithOwner: "example-org/example-repo" },
    issueFieldValues: { totalCount: 2, pageInfo: { hasNextPage: false, endCursor: `fv-${number}` },
      nodes: (["Priority", "Horizon"] as const).map((field) => ({
        __typename: "IssueFieldSingleSelectValue", name: field === "Priority" ? "P2" : "Later",
        value: field === "Priority" ? "P2" : "Later", field: { id: `F_${field}`, fullDatabaseId: "1", name: field },
      })) },
    timelineItems: { totalCount: events.length, pageInfo: { hasNextPage: false, hasPreviousPage: false,
      startCursor: "start", endCursor: "end" }, nodes: events },
  };
}

function snapshot(number: number): IssueSnapshotV2 {
  return {
    schemaVersion: ISSUE_SNAPSHOT_SCHEMA,
    identity: qualifyIssueIdentity(repository, { number, databaseId: 1_000 + number,
      nodeId: `I_${number}`, repositoryFullName: "example-org/example-repo" }),
    v1: { number, title: `Issue ${number}`, state: "OPEN", stateReason: null, type: null,
      fieldValues: [{ name: "Priority", value: "P2", field: { name: "Priority" } },
        { name: "Horizon", value: "Later", field: { name: "Horizon" } }],
      labels: [], assignees: [], milestone: null, bodySha256: sha256Bytes(`Body ${number}`),
      createdAt: "2026-01-01T00:00:00Z", updatedAt: capturedAt,
      relationships: { parent: null, subIssues: [], blockedBy: [], blocking: [] } },
    nativeType: null, relationships: { parent: null, subIssues: [], blockedBy: [], blocking: [] },
    projectMemberships: [], persistedVerifications: [], pullRequests: [],
    freshness: verificationFreshness([], capturedAt, main), transport: [],
  };
}

function capture(options: {
  body?: string; updatedAt?: string; blocker?: boolean;
  related?: "parent" | "subIssues" | "blocking"; expanded?: boolean; linkState?: "OPEN" | "CLOSED";
  sourceFiles?: Readonly<Record<string, string>>;
} = {}) {
  const nodes = options.linkState === "CLOSED" ? [censusIssue(1)] : [censusIssue(1), censusIssue(2)];
  if (options.body !== undefined) nodes[0].body = options.body;
  if (options.updatedAt !== undefined) nodes[0].updatedAt = options.updatedAt;
  const files: Readonly<Record<string, string>> = {
    [specPath]: spec, "src/current.ts": "export const current = true;\n",
    "src/expanded.ts": "export const expanded = true;\n",
    ...options.sourceFiles,
  };
  const runGit: StewardshipEvidenceGit = vi.fn((_cwd, args, output) => {
    if (args[0] === "rev-parse") return main;
    if (args[0] === "ls-tree") {
      const paths = args.includes("-r") ? Object.keys(files) : [args.at(-1)!].filter((path) => path in files);
      return paths.map((path) => `100644 blob ${sha256Bytes(path).slice(0, 40)}\t${path}\0`).join("");
    }
    if (args[0] === "cat-file") {
      expect(output).toEqual({ output: "base64", localObjectsOnly: true });
      const path = Object.keys(files).find((path) => sha256Bytes(path).slice(0, 40) === args[2])!;
      return Buffer.from(files[path]).toString("base64");
    }
    throw new Error(`unexpected git read ${args.join(" ")}`);
  });
  const runGh = vi.fn((args: readonly string[]) => {
    if (args.at(-1)?.endsWith("/commits/main")) return included({ sha: main });
    if (args.at(-1)?.endsWith(`/compare/${main}...main`)) return included({ status: "identical",
      ahead_by: 0, behind_by: 0, merge_base_commit: { sha: main }, commits: [] });
    const query = args.find((arg) => arg.startsWith("query=")) ?? "";
    if (query.includes("RoadmapStewardshipCensus")) return included({ data: { repository: {
      ...nodes[0].repository, issues: { totalCount: nodes.length,
        pageInfo: { hasNextPage: false, endCursor: null }, nodes },
    } } });
    if (query.includes("RoadmapStewardshipFieldHistory")) {
      const number = Number(args.find((arg) => arg.startsWith("number="))?.slice(7));
      return included({ data: { repository: { issue: { number, timelineItems: nodes[number - 1].timelineItems } } } });
    }
    throw new Error("unexpected GitHub read");
  });
  return collectStewardshipEvidence({
    repo: { owner: "example-org", name: "example-repo", fullName: "example-org/example-repo" }, repoRoot: "C:/repo",
    trustedVerificationAuthors: ["trusted-bot"], policyEvidence: { version: 1, rubric: "closed" },
    strategyPaths: [], sourcePathCandidatesByIssue: {
      1: ["src/current.ts", ...Object.keys(options.sourceFiles ?? {})], 2: ["src/current.ts"],
    },
    completionRulesByIssue: { 1: "Export `current`.", 2: "Export `current`." },
    ...(options.expanded ? { evidencePhase: "expanded" as const,
      selection: { mode: "targeted" as const, issueNumbers: [1] },
      sourceExcerptsByIssue: { 1: [{ path: "src/expanded.ts", startLine: 1, endLine: 1 }] } } : {}),
    generatedAt: capturedAt, runGh, runGit,
    hydrateIssue: ({ issueNumber }) => {
      const issue = snapshot(issueNumber);
      const link = { ...snapshot(2).identity, state: options.linkState ?? "OPEN" as const };
      return { ...issue, v1: { ...issue.v1, bodySha256: sha256Bytes(nodes[issueNumber - 1].body),
        updatedAt: nodes[issueNumber - 1].updatedAt },
        relationships: { ...issue.relationships,
          ...(options.blocker && issueNumber === 1 ? { blockedBy: [link] } : {}),
          ...(options.related && issueNumber === 1 ? {
            [options.related]: options.related === "parent" ? link : [link],
          } : {}) } };
    },
  });
}

type JournalEntry = { at: string; event: StewardshipEvent };

function fixture(options: Parameters<typeof capture>[0] = {}) {
  const generation = capture(options);
  const packet = generation.packets.find((packet) => packet.issueNumber === 1)!;
  const artifacts = new Map<string, unknown>();
  const archive = (value: unknown) => { const hash = canonicalJsonSha256(value); artifacts.set(hash, value); return hash; };
  const journal: JournalEntry[] = [];
  const state: StewardshipState = { adoptionId: "adopted", repository: "example-org/example-repo",
    policySha256: generation.policySha256, initializedAt: "2026-01-01T00:00:00Z", paused: false,
    sequence: 1, headSha256: "4".repeat(64), issues: {}, runs: {}, actions: {} };
  const record = (packet: StewardshipIssueEvidencePacket, at = capturedAt) => {
    const packetSha256 = archive(packet);
    journal.push({ at, event: { type: "evidence-recorded", issueNumber: 1,
      materialEvidenceSha256: packet.materialEvidenceSha256, packetSha256,
      originMainSha: generation.originMainSha, policySha256: generation.policySha256 } });
    const baseline = generation.baselines.find((baseline) => baseline.issueNumber === 1)!;
    const field = (name: "Priority" | "Horizon") => ({ value: baseline.fields[name],
      frontier: baseline.frontiers[name], lastCompleteFrontier: baseline.frontiers[name],
      materialEvidenceSha256: packet.materialEvidenceSha256, hold: null, provenanceBase: null, releasedAt: null });
    state.issues[1] ??= { baseline, fields: { Priority: field("Priority"), Horizon: field("Horizon") }, assessment: null };
    (state.issues[1].evidencePackets ??= {})[packet.materialEvidenceSha256] ??= {
      packetSha256, originMainSha: generation.originMainSha, policySha256: generation.policySha256,
    };
    return packetSha256;
  };
  const packetSha256 = record(packet);
  const readArtifact = vi.fn((hash: string): unknown => {
    if (!artifacts.has(hash)) throw new Error("missing artifact");
    return artifacts.get(hash);
  });
  const currentGeneration: StewardshipEvidenceGeneration = { ...generation,
    originMainSha: "b".repeat(40), generatedAt: "2026-10-21T12:00:00Z" };
  const input: StewardshipObservationReuseInput & {
    readArtifact: typeof readArtifact; blobsAtMain: Map<string, string>;
  } = {
    issueNumber: 1, generation: currentGeneration, journal, state, readArtifact,
    admission: { packetSha256, updatedAt: generation.census.updatedAtByIssue![1], digest: generation.census.digestByIssue![1] },
    blobsAtMain: new Map(packet.sources.map(({ path, blobOid }) => [path, blobOid])) };
  return { input, generation, packet, packetSha256, artifacts, archive, record };
}

describe("stewardship observation reuse", () => {
  it("ignores Sort key values and events in material validation and observation reuse", () => {
    const { input, packet, record } = fixture();
    const keyed = { ...packet, fields: { ...packet.fields, "Sort key": 19200 },
      issue: { ...packet.issue, v1: { ...packet.issue.v1, fieldValues: [...packet.issue.v1.fieldValues,
        { name: "Sort key", value: 19200, field: { name: "Sort key" } }] } },
      fieldHistory: { ...packet.fieldHistory, "Sort key": {
        frontier: { complete: true, eventIds: ["key"], cursor: null }, sha256: "e".repeat(64), events: [
          { id: "key", kind: "changed" as const, field: "Sort key" as const, actorLogin: "operator", createdAt: capturedAt,
            previousValues: [], values: ["19200"] },
        ],
      } } };
    input.admission = { ...input.admission!, packetSha256: record(keyed) };
    input.generation = { ...input.generation, census: { ...input.generation.census,
      members: [{ issueNumber: 1, state: "OPEN", fields: { "Sort key": 5040000 } }] } };
    expect(reuseStewardshipObservation(input)).toMatchObject({ reusable: true });
    input.generation = { ...input.generation, census: { ...input.generation.census,
      updatedAtByIssue: { ...input.generation.census.updatedAtByIssue, 1: "2026-10-21T12:00:00Z" } } };
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "changed" });
  });

  it("returns the unchanged latest admission with its original bindings", () => {
    const { input, packet, generation } = fixture();
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: true, evidence: {
      packet, originMainSha: generation.originMainSha, policySha256: generation.policySha256,
    } });
  });

  it("reuses a never-assessed observation while projection leaves the member uncovered", () => {
    const { input } = fixture();
    const result = reuseStewardshipObservation(input);
    expect(result.reusable).toBe(true);
    if (!result.reusable) throw new Error(result.reason);
    const projection = buildStewardshipProjection({ census: [{ issueNumber: 1, state: "OPEN" }],
      packets: [result.evidence.packet], journal: input.journal, state: input.state,
      readArtifact: input.readArtifact, operator: "operator", initializedAt: input.state.initializedAt });
    expect(projection.issues[1].status).toBe("unassessed");
    expect(projection.coverage.covered).toBe(0);
    expect(projection.coverage.unranked).toEqual([1]);
  });

  it("refuses evidence without a recorded latest admission", () => {
    const { input } = fixture();
    input.journal = [];
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "not_latest_admission" });
  });

  it("uses the later capture rather than the assessment's packet", () => {
    const { input, packet, record } = fixture();
    input.state.issues[1].assessment = { at: capturedAt,
      materialEvidenceSha256: packet.materialEvidenceSha256, decisionSha256: "d".repeat(64), result: "no-change" };
    const later = capture({ body: "Later captured body" });
    const laterPacket = later.packets.find((packet) => packet.issueNumber === 1)!;
    const packetSha256 = record(laterPacket, "2026-10-20T13:00:00Z");
    input.admission = { packetSha256, updatedAt: later.census.updatedAtByIssue![1], digest: later.census.digestByIssue![1] };
    input.generation = { ...input.generation, census: later.census };
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: true, evidence: {
      packet: laterPacket, originMainSha: later.originMainSha, policySha256: later.policySha256,
    } });
  });

  it("uses journal order when the material index retains the first packet", () => {
    const { input, packet, packetSha256: firstHash, record } = fixture();
    const later = capture({ updatedAt: "2026-10-20T13:00:00Z" });
    const latest = later.packets[0];
    expect(latest.materialEvidenceSha256).toBe(packet.materialEvidenceSha256);
    // Journal sequence, rather than timestamps or index insertion order, is authority.
    const packetSha256 = record(latest, "2026-10-20T11:00:00Z");
    expect(packetSha256).not.toBe(firstHash);
    expect(input.state.issues[1].evidencePackets![packet.materialEvidenceSha256].packetSha256).toBe(firstHash);
    input.admission = { packetSha256, updatedAt: later.census.updatedAtByIssue![1], digest: later.census.digestByIssue![1] };
    input.generation = { ...input.generation, census: later.census };
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: true, evidence: {
      packet: latest, originMainSha: later.originMainSha, policySha256: later.policySha256,
    } });
  });

  it("never reads assessment state", () => {
    const { input } = fixture();
    Object.defineProperty(input.state.issues[1], "assessment", { get: () => { throw new Error("assessment read"); } });
    expect(reuseStewardshipObservation(input).reusable).toBe(true);
  });

  it("refuses missing admission values instead of comparing two undefined digests", () => {
    const { input } = fixture();
    input.admission = undefined;
    input.generation = { ...input.generation, census: { ...input.generation.census, digestByIssue: undefined } };
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "not_latest_admission" });
  });

  it("refuses admission values bound to an older packet", () => {
    const { input, record } = fixture();
    record(capture({ body: "Later capture" }).packets[0]);
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "not_latest_admission" });
  });

  it("compares the producer's admission digest even when an intermediate census was missing", () => {
    const { input } = fixture();
    // This finished run has no readable census artifact. The caller retains the
    // last capture's admission, rather than substituting an intervening census.
    input.journal = [...input.journal, { at: "2026-10-20T14:00:00Z", event: {
      type: "run-finished", runId: "missing-intermediate-census", resultSha256: "0".repeat(64),
    } }];
    const changed = capture({ body: "Changed body" });
    input.generation = { ...input.generation, census: changed.census };
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "changed" });
    expect(input.readArtifact).toHaveBeenCalledTimes(1);
  });

  it("refuses a changed updatedAt even with an unchanged digest", () => {
    const { input } = fixture();
    input.generation = { ...input.generation, census: { ...input.generation.census,
      updatedAtByIssue: { ...input.generation.census.updatedAtByIssue, 1: "2026-10-21T10:00:00Z" } } };
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "changed" });
  });

  it("refuses a different active policy", () => {
    const { input } = fixture();
    input.generation = { ...input.generation, policySha256: "f".repeat(64) };
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "policy_mismatch" });
  });

  it("refuses a source absent from the pinned-main comparison", () => {
    const { input, packet } = fixture();
    input.blobsAtMain.delete(packet.sources[0].path);
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "sources_incomplete" });
  });

  it("refuses a source whose pinned-main blob changed", () => {
    const { input, packet } = fixture();
    input.blobsAtMain.set(packet.sources[0].path, "c".repeat(40));
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "sources_incomplete" });
  });

  it("checks expanded-only excerpt source blobs too", () => {
    const { input } = fixture({ expanded: true });
    expect(reuseStewardshipObservation(input).reusable).toBe(true);
    input.blobsAtMain.set("src/expanded.ts", "c".repeat(40));
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "sources_incomplete" });
  });

  it("reuses a runbook edited outside its rubric with the original packet bindings", () => {
    const { input, packet, generation } = fixture({ sourceFiles: { [runbookPath]: runbook } });
    const identity = stewardshipSourceSnippetIdentity(runbookPath, Buffer.from(runbook.replace("Other guidance.", "Updated intake guidance.")));
    const source = packet.sources.find(({ path }) => path === runbookPath)!;
    expect(identity).toEqual({ sha256: source.snippetSha256, byteLength: source.byteLength });
    input.blobsAtMain.set(runbookPath, "c".repeat(40));
    input.snippetAtMain = vi.fn(() => identity);
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: true, evidence: {
      packet, originMainSha: generation.originMainSha, policySha256: generation.policySha256,
    } });
    expect(input.snippetAtMain).toHaveBeenCalledExactlyOnceWith(runbookPath);
  });

  it("refuses a runbook edited inside its rubric", () => {
    const { input } = fixture({ sourceFiles: { [runbookPath]: runbook } });
    const identity = stewardshipSourceSnippetIdentity(runbookPath, Buffer.from(runbook.replace("Keep the journey moving.", "Revised priority rule.")));
    input.blobsAtMain.set(runbookPath, "c".repeat(40));
    input.snippetAtMain = vi.fn(() => identity);
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "sources_incomplete" });
    expect(input.snippetAtMain).toHaveBeenCalledExactlyOnceWith(runbookPath);
  });

  it("refuses a changed non-runbook whole-file source", () => {
    const { input } = fixture({ sourceFiles: { "STRATEGY.md": "Original strategy.\n" } });
    input.blobsAtMain.set("STRATEGY.md", "c".repeat(40));
    input.snippetAtMain = () => stewardshipSourceSnippetIdentity("STRATEGY.md", Buffer.from("Changed strategy.\n"));
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "sources_incomplete" });
  });

  it.each(["sources", "sourceExcerpts"] as const)("requires exact excerpt blobs in %s even with a matching snippet reader", (field) => {
    const { input, packet, generation, record } = fixture({ expanded: true });
    const source = packet.sources.find(({ excerpt }) => excerpt)!;
    const identity = stewardshipSourceSnippetIdentity(source.path, Buffer.from(source.text));
    expect(identity).toEqual({ sha256: source.snippetSha256, byteLength: source.byteLength });
    // Isolate the two excerpt-bearing collections rather than letting one mask the other.
    const changed = { ...packet, ...(field === "sources" ? { sourceExcerpts: [] }
      : { sources: packet.sources.filter((entry) => !entry.excerpt) }) };
    changed.materialEvidenceSha256 = stewardshipPacketMaterialSha256(changed, generation.originMainSha, generation.policySha256);
    input.admission = { ...input.admission!, packetSha256: record(changed) };
    input.blobsAtMain.set(source.path, "c".repeat(40));
    input.snippetAtMain = vi.fn(() => identity);
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "sources_incomplete" });
    expect(input.snippetAtMain).not.toHaveBeenCalled();
  });

  it.each(["unreadable", "non-UTF-8", "NUL", "missing"] as const)("refuses a null snippet identity for %s pinned-main bytes", (failure) => {
    const { input } = fixture({ sourceFiles: { [runbookPath]: runbook } });
    expect(stewardshipSourceSnippetIdentity(runbookPath, Buffer.from(runbook))).not.toBeNull();
    if (failure === "missing") input.blobsAtMain.delete(runbookPath);
    else input.blobsAtMain.set(runbookPath, "c".repeat(40));
    const identity = failure === "non-UTF-8" ? stewardshipSourceSnippetIdentity(runbookPath, Buffer.from([0xff]))
      : failure === "NUL" ? stewardshipSourceSnippetIdentity(runbookPath, Buffer.from(`${runbook}\0`)) : null;
    expect(identity).toBeNull();
    input.snippetAtMain = vi.fn(() => identity);
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "sources_incomplete" });
    expect(input.snippetAtMain).toHaveBeenCalledExactlyOnceWith(runbookPath);
  });

  it("refuses a matching runbook snippet hash with a different byte length", () => {
    const { input } = fixture({ sourceFiles: { [runbookPath]: runbook } });
    const identity = stewardshipSourceSnippetIdentity(runbookPath, Buffer.from(runbook))!;
    input.blobsAtMain.set(runbookPath, "c".repeat(40));
    input.snippetAtMain = vi.fn(() => ({ ...identity, byteLength: identity.byteLength + 1 }));
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "sources_incomplete" });
    expect(input.snippetAtMain).toHaveBeenCalledExactlyOnceWith(runbookPath);
  });

  it("reuses a CLOSED blocker absent from a complete open census", () => {
    const { input } = fixture({ blocker: true, linkState: "CLOSED" });
    expect(input.generation.census.complete).toBe(true);
    expect(input.generation.census.issueNumbers).toEqual([1]);
    expect(input.generation.census.members).toEqual([{ issueNumber: 1, state: "OPEN", fields: { "Sort key": null } }]);
    expect(reuseStewardshipObservation(input).reusable).toBe(true);
  });

  it("refuses a packet whose repository differs from the generation repository", () => {
    const { input } = fixture();
    input.generation = { ...input.generation, repository: qualifyRepositoryIdentity({
      organization: "example-org", name: "other-repo", databaseId: 2, nodeId: "R_other",
    }) };
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "cross_member_input_changed" });
  });

  it("refuses a cross-repository blocker with a matching number and state", () => {
    const { input, packet, generation, record } = fixture({ blocker: true });
    const otherRepository = qualifyRepositoryIdentity({
      organization: "example-org", name: "other-repo", databaseId: 2, nodeId: "R_other",
    });
    const changed = { ...packet, issue: { ...packet.issue, relationships: { ...packet.issue.relationships,
      blockedBy: [{ ...packet.issue.relationships.blockedBy[0], repository: otherRepository }] } } };
    changed.materialEvidenceSha256 = stewardshipPacketMaterialSha256(changed, generation.originMainSha, generation.policySha256);
    input.admission = { ...input.admission!, packetSha256: record(changed) };
    expect(input.generation.census.members).toContainEqual({ issueNumber: 2, state: "OPEN", fields: { "Sort key": null } });
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "blocker_state_changed" });
  });

  it("refuses a blocker with a state outside OPEN and CLOSED", () => {
    const { input, packet, generation, record } = fixture({ blocker: true });
    const changed = { ...packet, issue: { ...packet.issue, relationships: { ...packet.issue.relationships,
      blockedBy: [{ ...packet.issue.relationships.blockedBy[0], state: "UNKNOWN" as "OPEN" }] } } };
    changed.materialEvidenceSha256 = stewardshipPacketMaterialSha256(changed, generation.originMainSha, generation.policySha256);
    input.admission = { ...input.admission!, packetSha256: record(changed) };
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "blocker_state_changed" });
  });

  it("refuses an OPEN blocker now absent from a complete open census", () => {
    const { input } = fixture({ blocker: true });
    input.generation = { ...input.generation, census: capture({ linkState: "CLOSED" }).census };
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "blocker_state_changed" });
  });

  it.each(["OPEN", "CLOSED"] as const)("refuses an absent %s blocker when the open census is incomplete", (linkState) => {
    const { input } = fixture({ blocker: true, linkState });
    input.generation = { ...input.generation, census: { ...capture({ linkState: "CLOSED" }).census, complete: false } };
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "blocker_state_changed" });
  });

  it("uses issueNumbers to prove an OPEN blocker when members is missing", () => {
    const { input } = fixture({ blocker: true });
    input.generation = { ...input.generation, census: { ...input.generation.census, members: undefined } };
    expect(reuseStewardshipObservation(input).reusable).toBe(true);
  });

  it("reuses a CLOSED parent absent from a complete open census", () => {
    const { input } = fixture({ related: "parent", linkState: "CLOSED" });
    expect(input.generation.census.issueNumbers).toEqual([1]);
    expect(reuseStewardshipObservation(input).reusable).toBe(true);
  });

  it.each(["OPEN", "CLOSED"] as const)("refuses an absent %s parent when the open census is incomplete", (linkState) => {
    const { input } = fixture({ related: "parent", linkState });
    input.generation = { ...input.generation, census: { ...capture({ linkState: "CLOSED" }).census, complete: false } };
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "cross_member_input_changed" });
  });

  it.each(["parent", "subIssues", "blocking"] as const)("checks %s target state used by assessment currency", (related) => {
    const { input } = fixture({ related });
    expect(reuseStewardshipObservation(input).reusable).toBe(true);
    input.generation = { ...input.generation, census: capture({ linkState: "CLOSED" }).census };
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "cross_member_input_changed" });
  });

  it.each(["2026-11-02T12:00:00Z", "2026-11-02T12:00:00.001Z"])("refuses an expired packet at %s", (generatedAt) => {
    const { input } = fixture();
    input.generation = { ...input.generation, generatedAt };
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "packet_expired" });
  });

  it("accepts a packet just under the 13-day boundary", () => {
    const { input } = fixture();
    input.generation = { ...input.generation, generatedAt: "2026-11-02T11:59:59.999Z" };
    expect(reuseStewardshipObservation(input).reusable).toBe(true);
  });

  it("verifies canonical artifact content rather than JSON formatting", () => {
    const { input, packet, packetSha256 } = fixture();
    input.readArtifact.mockImplementation((hash) => {
      expect(hash).toBe(packetSha256);
      return JSON.parse(JSON.stringify(packet, null, 4));
    });
    expect(reuseStewardshipObservation(input).reusable).toBe(true);
  });

  it.each(["read", "parse", "hash"])("refuses a packet %s failure without throwing", (failure) => {
    const { input, packet, packetSha256, artifacts } = fixture();
    if (failure === "read") input.readArtifact.mockImplementation(() => { throw new Error("unreadable"); });
    if (failure === "parse") input.readArtifact.mockImplementation(() => JSON.parse("{"));
    if (failure === "hash") artifacts.set(packetSha256, { ...packet, title: "corrupted" });
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "packet_unreadable" });
  });

  it("does not fall back from an unreadable latest packet to an older one", () => {
    const { input, record, artifacts } = fixture();
    const later = capture({ body: "Later captured body" });
    const packetSha256 = record(later.packets[0]);
    input.admission = { packetSha256, updatedAt: later.census.updatedAtByIssue![1], digest: later.census.digestByIssue![1] };
    artifacts.delete(packetSha256);
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "packet_unreadable" });
  });

  it("checks packet material with its producer even when the artifact hash is valid", () => {
    const { input, packet, archive } = fixture();
    const packetSha256 = archive({ ...packet, title: "Changed title without a material rebind" });
    const latest = input.journal.at(-1)!;
    if (latest.event.type !== "evidence-recorded") throw new Error("missing fixture capture");
    latest.event.packetSha256 = packetSha256;
    input.admission = { ...input.admission!, packetSha256 };
    expect(reuseStewardshipObservation(input)).toEqual({ reusable: false, reason: "packet_unreadable" });
  });
});
