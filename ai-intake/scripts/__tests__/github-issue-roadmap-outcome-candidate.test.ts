import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/github-issue-roadmap/disposition-history", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/github-issue-roadmap/disposition-history")>(),
  dispositionHistory: () => new Map(),
}));

import { runCandidateCli } from "../github-issue-roadmap-intake-candidate";
import { canonicalJsonSha256 } from "../lib/github-issue-roadmap/canonical-json";
import {
  OUTCOME_ENVELOPE_SCHEMA_VERSION,
  OUTCOME_ENVELOPE_SCHEMA_VERSION_V2,
  PRODUCER_KINDS,
  activeOutcomeCandidates,
  assertAutomaticIntakeEnvelopeBudgets,
  createOutcomeEnvelope,
  outcomeEnvelopeJson,
  outcomeSourceContentMatchesSha256,
  outcomeSourceContentSha256,
  parseOutcomeEnvelope,
  type OutcomeDisposition,
  type OutcomeEnvelopeDraft,
  type ProducerKind,
} from "../lib/github-issue-roadmap/outcome-candidate";
import {
  SOURCE_MARKER,
  parseSourceMarker,
  renderSourceMarker,
} from "../lib/github-issue-roadmap/source-marker";
import { VERIFICATION_MARKER } from "../lib/github-issue-roadmap/snapshot-v2";
import { AUTHORED_START_COMMANDS, START_COMMAND_FIELD_VALUES } from "../lib/github-issue-roadmap/start-command-values";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("outcome source byte matching", () => {
  it("accepts exact bytes and LF-equivalent CRLF, but never normalizes invalid UTF-8", () => {
    const lf = Buffer.from("# Plan\nSource\n");
    const crlf = Buffer.from("# Plan\r\nSource\r\n");
    expect(outcomeSourceContentMatchesSha256(crlf, outcomeSourceContentSha256(crlf))).toBe(true);
    expect(outcomeSourceContentMatchesSha256(crlf, outcomeSourceContentSha256(lf))).toBe(true);
    expect(outcomeSourceContentMatchesSha256(Buffer.from("# Edited\n"), outcomeSourceContentSha256(lf))).toBe(false);
    const invalid = Buffer.from([0xff, 13, 10]);
    expect(outcomeSourceContentMatchesSha256(invalid, outcomeSourceContentSha256(invalid))).toBe(true);
    expect(outcomeSourceContentMatchesSha256(invalid, outcomeSourceContentSha256(Buffer.from("\ufffd\n")))).toBe(false);
  });
});
const FIXTURE_ROOT = resolve(
  process.cwd(),
  "scripts/__tests__/fixtures/github-issue-roadmap/outcome-candidates",
);

function draft(kind: ProducerKind, count = 1): OutcomeEnvelopeDraft {
  const safeKind = kind.replaceAll("_", "-");
  const sourceLocator = kind === "future_user_bug"
    ? `artifacts/github-issue-roadmap/user-bugs/${safeKind}.json`
    : `docs/plans/${safeKind}.md`;
  return {
    schemaVersion: OUTCOME_ENVELOPE_SCHEMA_VERSION,
    repository: {
      organization: "example-org",
      name: "example-repo",
      databaseId: 123,
      nodeId: "R_repo",
    },
    producer: { kind, version: "1" },
    artifact: {
      stableId: `artifact:${safeKind}`,
      revisionSha256: SHA_A,
      sourceLocator,
    },
    candidates: Array.from({ length: count }, (_unused, index) => ({
      stableOutcomeId: `outcome-${index + 1}`,
      outcome: {
        title: `Closeable ${kind} outcome ${index + 1}`,
        completionRule: `The repository proves outcome ${index + 1} is complete.`,
        affectedSystems: ["roadmap-intake", "producer-contract"],
      },
      evidence: [{
        id: `evidence-${index + 1}`,
        kind: "source_artifact",
        sourceLocator,
        contentSha256: SHA_A,
      }],
      provenance: [{
        id: `provenance-${index + 1}`,
        sourceLocator,
        contentSha256: SHA_A,
      }],
      readiness: {
        independentlyCloseable: true,
        framingComplete: true,
        completionRuleDefined: true,
        evidenceSufficient: true,
        estimationSubstrate: true,
        unresolvedDecisionIds: [],
        dependencyIds: [],
        currentMainVerificationEvidenceId: null,
      },
      relationshipCandidates: [],
      suggestions: {
        type: { value: "Feature", confidence: "high", rationale: "A product capability." },
        priority: { value: "P2", confidence: "high", rationale: "Strong rubric evidence." },
        effort: { value: "Medium", confidence: "high", rationale: "Enough substrate exists." },
      },
    })),
  };
}

function mutable(value: unknown): Record<string, unknown> {
  return structuredClone(value) as Record<string, unknown>;
}

describe("producer-neutral outcome envelope", () => {
// Private captured-fixture replay is excluded from this public source copy.


  it("round-trips a committed-shape v2 sidecar with authored criteria through the same check", () => {
    const v2 = createOutcomeEnvelope({
      ...draft("plan"), schemaVersion: OUTCOME_ENVELOPE_SCHEMA_VERSION_V2,
      candidates: draft("plan").candidates.map((candidate) => ({
        ...candidate, acceptanceCriteria: ["The filed issue lists this criterion."],
      })),
    });
    const raw = JSON.parse(outcomeEnvelopeJson(v2));
    const parsed = parseOutcomeEnvelope(raw);
    expect(parsed.schemaVersion).toBe(OUTCOME_ENVELOPE_SCHEMA_VERSION_V2);
    expect(parsed.candidates[0].acceptanceCriteria).toEqual(["The filed issue lists this criterion."]);
    expect(canonicalJsonSha256(parsed)).toBe(canonicalJsonSha256(raw));
  });

  it.each(PRODUCER_KINDS)("accepts zero, one, and many candidates for %s", (kind) => {
    for (const count of [0, 1, 3]) {
      const envelope = createOutcomeEnvelope(draft(kind, count));
      expect(parseOutcomeEnvelope(envelope).candidates).toHaveLength(count);
    }
  });

  it("keeps replay and revision identity deterministic across material-equivalent ordering", () => {
    const firstDraft = draft("plan", 2);
    firstDraft.candidates[0].evidence.push({
      id: "another-evidence",
      kind: "repository_fact",
      sourceLocator: "scripts/github-issue-roadmap-intake-candidate.ts",
      contentSha256: SHA_B,
    });
    firstDraft.candidates[0].provenance.push({
      id: "another-provenance",
      sourceLocator: "scripts/github-issue-roadmap-intake-candidate.ts",
      contentSha256: SHA_B,
    });
    const reorderedDraft = structuredClone(firstDraft);
    reorderedDraft.candidates.reverse();
    reorderedDraft.candidates[0].outcome.affectedSystems.reverse();
    reorderedDraft.candidates[1].evidence.reverse();
    reorderedDraft.candidates[1].provenance.reverse();
    const first = createOutcomeEnvelope(firstDraft);
    const reordered = createOutcomeEnvelope(reorderedDraft);

    expect(outcomeEnvelopeJson(reordered)).toBe(outcomeEnvelopeJson(first));
    expect(first.candidates.map((candidate) => candidate.sourceFingerprint))
      .toEqual(reordered.candidates.map((candidate) => candidate.sourceFingerprint));
    expect(first.candidates.map((candidate) => candidate.emissionContentSha256))
      .toEqual(reordered.candidates.map((candidate) => candidate.emissionContentSha256));
  });

  it("keeps a stable fingerprint but changes the emission hash for revised evidence", () => {
    const original = createOutcomeEnvelope(draft("audit"));
    const revisionDraft = draft("audit");
    revisionDraft.candidates[0].evidence.push({
      id: "evidence-revision",
      kind: "current_main_verification",
      sourceLocator: "artifacts/github-issue-roadmap/verifications/current-main.json",
      contentSha256: SHA_B,
    });
    revisionDraft.candidates[0].readiness.currentMainVerificationEvidenceId = "evidence-revision";
    const revision = createOutcomeEnvelope(revisionDraft);

    expect(revision.candidates[0].sourceFingerprint)
      .toBe(original.candidates[0].sourceFingerprint);
    expect(revision.candidates[0].emissionContentSha256)
      .not.toBe(original.candidates[0].emissionContentSha256);
  });

  it("keeps similar prose distinct when stable producer outcome IDs differ", () => {
    const first = createOutcomeEnvelope(draft("brainstorm"));
    const secondDraft = draft("brainstorm");
    secondDraft.candidates[0].stableOutcomeId = "another-closeable-outcome";
    const second = createOutcomeEnvelope(secondDraft);
    expect(second.candidates[0].sourceFingerprint)
      .not.toBe(first.candidates[0].sourceFingerprint);
  });

  it("loads canonical happy-path fixtures", () => {
    for (const name of ["plan-one.json", "audit-many.json", "future-user-bug-one.json", "ideation-zero.json"]) {
      const fixture = JSON.parse(readFileSync(resolve(FIXTURE_ROOT, name), "utf8"));
      const parsed = parseOutcomeEnvelope(createOutcomeEnvelope(fixture));
      expect(parsed.schemaVersion).toBe(OUTCOME_ENVELOPE_SCHEMA_VERSION);
    }
  });
});

describe("v2 outcome dispositions", () => {
  const achieved = {
    kind: "achieved",
    commits: [{ sha: "a".repeat(40) }],
    note: "The outcome is complete on main.",
  } satisfies OutcomeDisposition;
  const superseded = {
    kind: "superseded",
    target: { stableArtifactId: "artifact:replacement", stableOutcomeId: "replacement-outcome" },
    note: "The replacement carries this work forward.",
  } satisfies OutcomeDisposition;

  function v2Draft(count = 1): OutcomeEnvelopeDraft {
    return { ...draft("plan", count), schemaVersion: OUTCOME_ENVELOPE_SCHEMA_VERSION_V2 };
  }

  it.each([achieved, superseded])("round-trips $kind and changes only that candidate's emission hash", (disposition) => {
    const input = v2Draft(3);
    const absent = createOutcomeEnvelope(input);
    input.candidates[1].disposition = structuredClone(disposition);
    const envelope = parseOutcomeEnvelope(JSON.parse(outcomeEnvelopeJson(createOutcomeEnvelope(input))));
    for (const candidate of envelope.candidates) {
      const original = absent.candidates.find((entry) => entry.stableOutcomeId === candidate.stableOutcomeId)!;
      expect(candidate.sourceFingerprint).toBe(original.sourceFingerprint);
      if (candidate.stableOutcomeId === input.candidates[1].stableOutcomeId) {
        expect(candidate.disposition).toEqual(disposition);
        expect(candidate.emissionContentSha256).not.toBe(original.emissionContentSha256);
      } else {
        expect(candidate).toEqual(original);
      }
    }
    expect(() => parseOutcomeEnvelope({
      ...absent,
      candidates: absent.candidates.map((candidate) => candidate.stableOutcomeId === input.candidates[1].stableOutcomeId
        ? { ...candidate, disposition }
        : candidate),
    })).toThrow(/emissionContentSha256/);
  });

  it.each([achieved, superseded, undefined])("refuses a v1 disposition even with %j", (disposition) => {
    const input = draft("plan");
    const envelope = createOutcomeEnvelope(input);
    expect(() => createOutcomeEnvelope({
      ...input, candidates: [{ ...input.candidates[0], disposition }],
    })).toThrow(/exact keys/);
    expect(() => parseOutcomeEnvelope({
      ...envelope, candidates: [{ ...envelope.candidates[0], disposition }],
    })).toThrow(/exact keys/);
  });

  it("omits an absent or undefined disposition before hashing and writing", () => {
    const input = v2Draft();
    input.candidates[0].acceptanceCriteria = ["The criterion survives normalization."];
    input.candidates[0].startCommand = "ce-debug";
    const absent = createOutcomeEnvelope(input);
    input.candidates[0].disposition = undefined;
    expect(Object.hasOwn(input.candidates[0], "disposition")).toBe(true);
    const explicitUndefined = createOutcomeEnvelope(input);
    const parsedUndefined = parseOutcomeEnvelope({
      ...absent, candidates: [{ ...absent.candidates[0], disposition: undefined }],
    });
    for (const envelope of [absent, explicitUndefined, parsedUndefined]) {
      expect(Object.hasOwn(envelope.candidates[0], "disposition")).toBe(false);
      expect(envelope).toEqual(absent);
      expect(outcomeEnvelopeJson(envelope)).toBe(outcomeEnvelopeJson(absent));
    }
  });

  it("normalizes notes, commit SHAs and supersession identifiers", () => {
    const input = v2Draft(2);
    input.candidates[0].disposition = {
      ...achieved,
      commits: [{ sha: `  ${"b".repeat(40)}  ` }, { sha: "a".repeat(40) }],
      note: "  Delivered.\r\nVerified on main.  ",
    };
    input.candidates[1].disposition = {
      ...superseded,
      target: { stableArtifactId: "  artifact:replacement  ", stableOutcomeId: "  replacement-outcome  " },
      note: "  Replaced.\r\nUse the target.  ",
    };
    const envelope = parseOutcomeEnvelope(createOutcomeEnvelope(input));
    expect(envelope.candidates.find((candidate) => candidate.stableOutcomeId === "outcome-1")?.disposition)
      .toEqual({ ...achieved, commits: [{ sha: "b".repeat(40) }, { sha: "a".repeat(40) }], note: "Delivered.\nVerified on main." });
    expect(envelope.candidates.find((candidate) => candidate.stableOutcomeId === "outcome-2")?.disposition)
      .toEqual({ ...superseded, note: "Replaced.\nUse the target." });
  });

  it.each([achieved, superseded])("accepts a bounded 1000-character $kind note after trimming", (disposition) => {
    const input = v2Draft();
    input.candidates[0].disposition = { ...disposition, note: `  ${"x".repeat(1_000)}  ` };
    expect(parseOutcomeEnvelope(createOutcomeEnvelope(input)).candidates[0].disposition?.note).toHaveLength(1_000);
  });

  it.each([
    ["null", null, /disposition must be an object/],
    ["a non-object", "achieved", /disposition must be an object/],
    ["an unknown kind", { ...achieved, kind: "reopened" }, /kind is unsupported/],
    ["a short SHA", { ...achieved, commits: [{ sha: "a".repeat(39) }] }, /40-character lowercase hex/],
    ["a long SHA", { ...achieved, commits: [{ sha: "a".repeat(41) }] }, /40-character lowercase hex/],
    ["an uppercase SHA", { ...achieved, commits: [{ sha: "A".repeat(40) }] }, /40-character lowercase hex/],
    ["a non-hex SHA", { ...achieved, commits: [{ sha: "g".repeat(40) }] }, /40-character lowercase hex/],
    ["duplicate SHAs after trimming", { ...achieved, commits: [{ sha: "a".repeat(40) }, { sha: `  ${"a".repeat(40)}  ` }] }, /\.commits contains duplicate SHAs/],
    ["an empty commit list", { ...achieved, commits: [] }, /commits must be a non-empty array/],
    ["a non-array commit list", { ...achieved, commits: {} }, /commits must be a non-empty array/],
    ["a non-object commit", { ...achieved, commits: ["a".repeat(40)] }, /commits\[0\] must be an object/],
    ["a missing SHA", { ...achieved, commits: [{}] }, /exact keys/],
    ["an extra commit key", { ...achieved, commits: [{ sha: "a".repeat(40), pr: 123 }] }, /exact keys/],
    ["an extra disposition key", { ...achieved, pr: 123 }, /exact keys/],
    ["mixed kind fields", { ...superseded, commits: achieved.commits }, /exact keys/],
    ["a missing note", { kind: "achieved", commits: achieved.commits }, /exact keys/],
    ["an empty note", { ...achieved, note: "" }, /note must be a non-empty string/],
    ["a blank note", { ...superseded, note: " \r\n " }, /note must be a non-empty string/],
    ["a non-string note", { ...achieved, note: 42 }, /note must be a non-empty string/],
    ["an oversized note", { ...superseded, note: "x".repeat(1_001) }, /note must be at most 1000 characters/],
    ["a missing target", { kind: "superseded", note: superseded.note }, /exact keys/],
    ["a non-object target", { ...superseded, target: null }, /target must be an object/],
    ["a missing target identifier", { ...superseded, target: { stableArtifactId: "artifact:replacement" } }, /exact keys/],
    ["an extra target key", { ...superseded, target: { ...superseded.target, pr: 123 } }, /exact keys/],
    ["an empty target identifier", { ...superseded, target: { ...superseded.target, stableOutcomeId: "" } }, /stableOutcomeId must be a non-empty string/],
    ["an unsafe target identifier", { ...superseded, target: { ...superseded.target, stableArtifactId: "artifact replacement" } }, /stableArtifactId must be a stable identifier/],
    ["an oversized target identifier", { ...superseded, target: { ...superseded.target, stableOutcomeId: "x".repeat(257) } }, /stableOutcomeId must be a stable identifier/],
  ] as const)("refuses %s in create, parse and budget exemption", (_label, disposition, message) => {
    const input = v2Draft();
    const envelope = createOutcomeEnvelope(input);
    expect(() => createOutcomeEnvelope({
      ...input, candidates: [{ ...input.candidates[0], disposition }],
    })).toThrow(message);
    expect(() => parseOutcomeEnvelope({
      ...envelope, candidates: [{ ...envelope.candidates[0], disposition }],
    })).toThrow(message);
    const overBudget = v2Draft(6);
    expect(() => assertAutomaticIntakeEnvelopeBudgets({
      ...overBudget, candidates: overBudget.candidates.map((candidate, index) => index === 0
        ? { ...candidate, disposition }
        : candidate),
    })).toThrow(message);
  });

  it("partitions a mixed envelope while preserving the order and references in each part", () => {
    const input = v2Draft(5);
    input.candidates[1].disposition = achieved;
    input.candidates[3].disposition = superseded;
    const envelope = parseOutcomeEnvelope(createOutcomeEnvelope(input));
    const candidates = [4, 1, 2, 5, 3].map((index) => envelope.candidates.find((candidate) =>
      candidate.stableOutcomeId === `outcome-${index}`)!);
    const orderedEnvelope = { ...envelope, candidates };
    const { active, dispositioned } = activeOutcomeCandidates(orderedEnvelope);
    expect(active.map((candidate) => candidate.stableOutcomeId)).toEqual(["outcome-1", "outcome-5", "outcome-3"]);
    expect(dispositioned.map((candidate) => candidate.stableOutcomeId)).toEqual(["outcome-4", "outcome-2"]);
    expect(active[0]).toBe(candidates[1]);
    expect(dispositioned[0]).toBe(candidates[0]);
    expect(orderedEnvelope.candidates).toEqual(candidates);
  });

  it("partitions empty, entirely active and entirely dispositioned envelopes", () => {
    expect(activeOutcomeCandidates(createOutcomeEnvelope(v2Draft(0)))).toEqual({ active: [], dispositioned: [] });
    const input = v2Draft(2);
    const active = createOutcomeEnvelope(input);
    expect(activeOutcomeCandidates(active)).toEqual({ active: active.candidates, dispositioned: [] });
    input.candidates.forEach((candidate) => { candidate.disposition = achieved; });
    const dispositioned = createOutcomeEnvelope(input);
    expect(activeOutcomeCandidates(dispositioned)).toEqual({ active: [], dispositioned: dispositioned.candidates });
  });

  it("budgets active candidates only in drafts and parsed envelopes", () => {
    const input = v2Draft(7);
    input.candidates[1].disposition = achieved;
    input.candidates[5].disposition = superseded;
    expect(() => assertAutomaticIntakeEnvelopeBudgets(input)).not.toThrow();
    expect(() => assertAutomaticIntakeEnvelopeBudgets(parseOutcomeEnvelope(createOutcomeEnvelope(input)))).not.toThrow();
    input.candidates[1].disposition = undefined;
    expect(() => assertAutomaticIntakeEnvelopeBudgets(input)).toThrow(/at most five active candidates/);
    expect(() => assertAutomaticIntakeEnvelopeBudgets(createOutcomeEnvelope(input))).toThrow(/at most five active candidates/);
    expect(() => assertAutomaticIntakeEnvelopeBudgets(v2Draft(6))).toThrow(/at most five active candidates/);
    expect(() => assertAutomaticIntakeEnvelopeBudgets({ ...input, schemaVersion: OUTCOME_ENVELOPE_SCHEMA_VERSION }))
      .toThrow(/at most five active candidates/);
  });

  it("keeps byte limits over every dispositioned candidate and the full envelope", () => {
    const input = v2Draft(7);
    input.candidates.forEach((candidate) => { candidate.disposition = achieved; });
    input.candidates[6].outcome.completionRule = "é".repeat(8_192);
    expect(() => assertAutomaticIntakeEnvelopeBudgets(input)).toThrow(/candidate 6.*16 KiB/);
    input.candidates.forEach((candidate) => { candidate.outcome.completionRule = "x".repeat(10_000); });
    for (const candidate of input.candidates) expect(Buffer.byteLength(JSON.stringify(candidate), "utf8")).toBeLessThan(16 * 1_024);
    expect(() => assertAutomaticIntakeEnvelopeBudgets(input)).toThrow(/envelope.*64 KiB/);
  });
});

describe("v2 authored Start commands", () => {
  function v2Draft(): OutcomeEnvelopeDraft {
    return { ...draft("plan"), schemaVersion: OUTCOME_ENVELOPE_SCHEMA_VERSION_V2 };
  }

  it.each(["ce-debug", undefined])("refuses startCommand as an unknown v1 key even with %s", (startCommand) => {
    const input = draft("plan");
    const envelope = createOutcomeEnvelope(input);
    expect(() => createOutcomeEnvelope({
      ...input, candidates: [{ ...input.candidates[0], startCommand }],
    })).toThrow(/exact keys/);
    expect(() => parseOutcomeEnvelope({
      ...envelope, candidates: [{ ...envelope.candidates[0], startCommand }],
    })).toThrow(/exact keys/);
  });

  it.each(AUTHORED_START_COMMANDS)("parses %s and binds it to emission content only", (startCommand) => {
    const input = v2Draft();
    const absent = createOutcomeEnvelope(input);
    const envelope = parseOutcomeEnvelope(JSON.parse(outcomeEnvelopeJson(createOutcomeEnvelope({
      ...input, candidates: [{ ...input.candidates[0], startCommand }],
    }))));
    expect(envelope.candidates[0].startCommand).toBe(startCommand);
    expect(envelope.candidates[0].sourceFingerprint).toBe(absent.candidates[0].sourceFingerprint);
    expect(envelope.candidates[0].emissionContentSha256).not.toBe(absent.candidates[0].emissionContentSha256);
    expect(() => parseOutcomeEnvelope({
      ...absent, candidates: [{ ...absent.candidates[0], startCommand }],
    })).toThrow(/emissionContentSha256/);
  });

  it("changes the emission hash with each authored value while preserving identity", () => {
    const input = v2Draft();
    const candidates = AUTHORED_START_COMMANDS.map((startCommand) => createOutcomeEnvelope({
      ...input, candidates: [{ ...input.candidates[0], startCommand }],
    }).candidates[0]);
    expect(new Set(candidates.map(({ emissionContentSha256 }) => emissionContentSha256)).size)
      .toBe(AUTHORED_START_COMMANDS.length);
    expect(new Set(candidates.map(({ sourceFingerprint }) => sourceFingerprint)).size).toBe(1);
  });

  it.each(["ce-resolve-pr-feedback", "none", "", null, "ce-prototype", 42])(
    "refuses an unauthored Start command %j in create and parse", (startCommand) => {
      const input = v2Draft();
      const envelope = createOutcomeEnvelope(input);
      expect(() => createOutcomeEnvelope({
        ...input, candidates: [{ ...input.candidates[0], startCommand }],
      })).toThrow(/startCommand/);
      expect(() => parseOutcomeEnvelope({
        ...envelope, candidates: [{ ...envelope.candidates[0], startCommand }],
      })).toThrow(/startCommand/);
    },
  );

  it.each([{ acceptanceCriteria: undefined }, { acceptanceCriteria: ["The authored criterion survives."] }])(
    "omits absent and undefined Start commands independently of criteria $acceptanceCriteria", ({ acceptanceCriteria }) => {
      const input = v2Draft();
      if (acceptanceCriteria !== undefined) input.candidates[0].acceptanceCriteria = acceptanceCriteria;
      const absent = createOutcomeEnvelope(input);
      input.candidates[0].startCommand = undefined;
      expect(Object.hasOwn(input.candidates[0], "startCommand")).toBe(true);
      const explicitUndefined = createOutcomeEnvelope(input);
      const parsedUndefined = parseOutcomeEnvelope({
        ...absent, candidates: [{ ...absent.candidates[0], startCommand: undefined }],
      });
      for (const envelope of [absent, explicitUndefined, parsedUndefined]) {
        expect(Object.hasOwn(envelope.candidates[0], "startCommand")).toBe(false);
        expect(envelope.candidates[0].emissionContentSha256).toBe(absent.candidates[0].emissionContentSha256);
        expect(Buffer.from(outcomeEnvelopeJson(envelope))).toEqual(Buffer.from(outcomeEnvelopeJson(absent)));
      }
      const authored = parseOutcomeEnvelope(createOutcomeEnvelope({
        ...input, candidates: [{ ...input.candidates[0], startCommand: "ce-debug" }],
      }));
      expect(authored.candidates[0].startCommand).toBe("ce-debug");
      expect(authored.candidates[0].acceptanceCriteria).toEqual(acceptanceCriteria);
    },
  );

  it("keeps every authored command within the Start field values", () => {
    for (const value of AUTHORED_START_COMMANDS) expect(START_COMMAND_FIELD_VALUES).toContain(value);
  });
});

describe("v2 acceptance criteria", () => {
  function v2Draft(): OutcomeEnvelopeDraft {
    return { ...draft("plan"), schemaVersion: OUTCOME_ENVELOPE_SCHEMA_VERSION_V2 };
  }

  function expectCriteriaRefused(acceptanceCriteria: unknown, message: RegExp): void {
    const input = v2Draft();
    const envelope = createOutcomeEnvelope(input);
    expect(() => createOutcomeEnvelope({
      ...input,
      candidates: [{ ...input.candidates[0], acceptanceCriteria }],
    })).toThrow(message);
    expect(() => parseOutcomeEnvelope({
      ...envelope,
      candidates: [{ ...envelope.candidates[0], acceptanceCriteria }],
    })).toThrow(message);
  }

  it.each([
    ["a list", ["The outcome is verified."]],
    ["an empty list", []],
    ["undefined", undefined],
  ] as const)("refuses acceptanceCriteria as an unknown v1 candidate key even with %s", (_label, acceptanceCriteria) => {
    const input = draft("plan");
    const envelope = createOutcomeEnvelope(input);
    expect(() => createOutcomeEnvelope({
      ...input,
      candidates: [{ ...input.candidates[0], acceptanceCriteria }],
    })).toThrow(/exact keys/);
    expect(() => parseOutcomeEnvelope({
      ...envelope,
      candidates: [{ ...envelope.candidates[0], acceptanceCriteria }],
    })).toThrow(/exact keys/);
  });

  it("preserves trimmed authored order and binds criteria to the emission hash only", () => {
    const input = v2Draft();
    input.candidates[0].acceptanceCriteria = ["  Zeta is verified.  ", "Alpha is verified.", "Middle is verified."];
    const original = parseOutcomeEnvelope(JSON.parse(outcomeEnvelopeJson(createOutcomeEnvelope(input))));
    expect(original.schemaVersion).toBe(OUTCOME_ENVELOPE_SCHEMA_VERSION_V2);
    expect(original.candidates[0].acceptanceCriteria).toEqual([
      "Zeta is verified.", "Alpha is verified.", "Middle is verified.",
    ]);

    input.candidates[0].acceptanceCriteria[1] = "Alpha has an updated completion condition.";
    const revision = parseOutcomeEnvelope(createOutcomeEnvelope(input));
    expect(revision.candidates[0].sourceFingerprint).toBe(original.candidates[0].sourceFingerprint);
    expect(revision.candidates[0].emissionContentSha256).not.toBe(original.candidates[0].emissionContentSha256);
    expect(() => parseOutcomeEnvelope({
      ...original,
      candidates: [{ ...original.candidates[0], acceptanceCriteria: revision.candidates[0].acceptanceCriteria }],
    })).toThrow(/emissionContentSha256/);
  });

  it("omits absent and empty criteria before hashing and writing", () => {
    const input = v2Draft();
    const absent = parseOutcomeEnvelope(createOutcomeEnvelope(input));
    input.candidates[0].acceptanceCriteria = [];
    const empty = createOutcomeEnvelope(input);
    const parsedEmpty = parseOutcomeEnvelope({
      ...absent,
      candidates: [{ ...absent.candidates[0], acceptanceCriteria: [] }],
    });
    for (const envelope of [absent, empty, parsedEmpty]) {
      expect(Object.hasOwn(envelope.candidates[0], "acceptanceCriteria")).toBe(false);
      expect(envelope.candidates[0].emissionContentSha256).toBe(absent.candidates[0].emissionContentSha256);
      expect(outcomeEnvelopeJson(envelope)).toBe(outcomeEnvelopeJson(absent));
      expect(outcomeEnvelopeJson(envelope)).not.toContain("acceptanceCriteria");
    }
  });

  it("omits explicitly undefined criteria before hashing and writing", () => {
    const input = v2Draft();
    const absent = createOutcomeEnvelope(input);
    input.candidates[0].acceptanceCriteria = undefined;
    expect(Object.hasOwn(input.candidates[0], "acceptanceCriteria")).toBe(true);
    const explicitUndefined = createOutcomeEnvelope(input);
    const parsedUndefined = parseOutcomeEnvelope({
      ...absent,
      candidates: [{ ...absent.candidates[0], acceptanceCriteria: undefined }],
    });
    for (const envelope of [explicitUndefined, parsedUndefined]) {
      expect(envelope).toEqual(absent);
      expect(Object.hasOwn(envelope.candidates[0], "acceptanceCriteria")).toBe(false);
      expect(envelope.candidates[0].emissionContentSha256).toBe(absent.candidates[0].emissionContentSha256);
      expect(outcomeEnvelopeJson(envelope)).toBe(outcomeEnvelopeJson(absent));
    }
  });

  it("accepts 12 criteria with 300 characters each after trimming", () => {
    const input = v2Draft();
    const criteria = Array.from({ length: 12 }, (_, index) => `Criterion ${index}`.padEnd(300, "."));
    input.candidates[0].acceptanceCriteria = criteria.map((criterion) => `  ${criterion}  `);
    expect(parseOutcomeEnvelope(createOutcomeEnvelope(input)).candidates[0].acceptanceCriteria).toEqual(criteria);
  });

  it("accepts an issue reference at the start of a criterion", () => {
    const input = v2Draft();
    input.candidates[0].acceptanceCriteria = ["#123 must stay closed"];
    expect(parseOutcomeEnvelope(createOutcomeEnvelope(input)).candidates[0].acceptanceCriteria).toEqual(["#123 must stay closed"]);
  });

  it.each(["state A --> state B", "-->"])("accepts a comment closer as ordinary prose: %s", (criterion) => {
    const input = v2Draft();
    input.candidates[0].acceptanceCriteria = [criterion];
    expect(parseOutcomeEnvelope(JSON.parse(outcomeEnvelopeJson(createOutcomeEnvelope(input)))).candidates[0].acceptanceCriteria)
      .toEqual([criterion]);
  });

  it.each([
    ["a non-array", "Criterion", /acceptanceCriteria must be an array/],
    ["a non-string item", [42], /acceptanceCriteria\[0\] must be a string/],
    ["a blank item", ["   "], /non-empty after trimming/],
    ["a newline", ["First\nSecond"], /single line/],
    ["a carriage return", ["First\rSecond"], /single line/],
    ["a next-line separator", ["First\u0085Second"], /single line/],
    ["a line separator", ["First\u2028Second"], /single line/],
    ["a paragraph separator", ["First\u2029Second"], /single line/],
    ["a trailing newline", ["Criterion\n"], /single line/],
    ["an embedded tab", ["First\tSecond"], /control or invisible characters/],
    ["a leading tab", ["\tCriterion"], /control or invisible characters/],
    ["a trailing tab", ["Criterion\t"], /control or invisible characters/],
    ["a vertical tab", ["First\vSecond"], /control or invisible characters/],
    ["a form feed", ["First\fSecond"], /control or invisible characters/],
    ["a null control", ["First\u0000Second"], /control or invisible characters/],
    ["a delete control", ["First\u007fSecond"], /control or invisible characters/],
    ["a zero-width space", ["First\u200bSecond"], /control or invisible characters/],
    ["a bidi override", ["First\u202eSecond"], /control or invisible characters/],
    ["a supplementary format character", ["First\u{e0001}Second"], /control or invisible characters/],
    ["a lone surrogate", ["x\ud800lone"], /control or invisible characters/],
    ["a tab after a dash marker", ["-\tfoo"], /control or invisible characters/],
    ["a tab after a star marker", ["*\tfoo"], /control or invisible characters/],
    ["a tab after a plus marker", ["+\tfoo"], /control or invisible characters/],
    ["a tab after a numbered dot marker", ["1.\tfoo"], /control or invisible characters/],
    ["a tab after a numbered parenthesis marker", ["12)\tfoo"], /control or invisible characters/],
    ["a bare dash marker", ["-"], /list, heading, or checkbox marker/],
    ["a non-breaking space after a dash marker", ["-\u00a0foo"], /list, heading, or checkbox marker/],
    ["a bare star marker", ["*"], /list, heading, or checkbox marker/],
    ["a bare plus marker", ["+"], /list, heading, or checkbox marker/],
    ["a bare numbered dot marker", ["1."], /list, heading, or checkbox marker/],
    ["a bare numbered parenthesis marker", ["12)"], /list, heading, or checkbox marker/],
    ["a bare heading marker", ["#"], /list, heading, or checkbox marker/],
    ["an ATX heading", ["# Heading"], /list, heading, or checkbox marker/],
    ["a level-six ATX heading", ["###### Heading"], /list, heading, or checkbox marker/],
    ["sentinel text", ["Reject <!-- github-issue-roadmap-source --> text"], /source-marker sentinel/],
    ["a versioned mixed-case sentinel", ["Reject <!--GITHUB-ISSUE-ROADMAP-SOURCE:v2--> text"], /source-marker sentinel/],
    ["a bare HTML comment opener", ["<!--"], /HTML comment|source-marker sentinel/],
    ["an embedded HTML comment opener", ["Criterion <!-- hides following text"], /HTML comment|source-marker sentinel/],
    ["unwrapped sentinel text", ["Reject github-issue-roadmap-source text"], /source-marker sentinel/],
    ["a mixed-case near-miss sentinel", ["Reject GITHUB-ISSUE-ROADMAP-SOURCE:v2 text"], /source-marker sentinel/],
    ["a sentinel substring", ["Reject prefixgithub-issue-roadmap-sourcesuffix text"], /source-marker sentinel/],
    ["a duplicate after trimming", ["Criterion", "  Criterion  "], /duplicates after trimming/],
    ["13 items", Array.from({ length: 13 }, (_, index) => `Criterion ${index}`), /at most 12 items/],
    ["a 301-character item", ["x".repeat(301)], /at most 300 characters/],
  ] as const)("refuses %s", (_label, value, message) => {
    expectCriteriaRefused(value, message);
  });

  it.each(["- ", "* ", "+ ", "1. ", "12) ", "# ", "[ ]", "[x]", "[X]", "- [ ]"])(
    "refuses leading marker %s",
    (marker) => expectCriteriaRefused([`  ${marker}Criterion  `], /list, heading, or checkbox marker/),
  );

  it("refuses unknown schema versions", () => {
    const input = v2Draft();
    const schemaVersion = "github-issue-roadmap-outcome-envelope/v99";
    expect(() => createOutcomeEnvelope({ ...input, schemaVersion })).toThrow(/schemaVersion.*unsupported/);
    expect(() => parseOutcomeEnvelope({ ...createOutcomeEnvelope(input), schemaVersion })).toThrow(/schemaVersion.*unsupported/);
  });
});

describe("strict and privacy-safe validation", () => {
  it.each([255, 256])("preserves a %i-character title through creation and parsing", (length) => {
    const input = draft("plan");
    input.candidates[0].outcome.title = "x".repeat(length);
    const envelope = createOutcomeEnvelope(input);
    expect(envelope.candidates[0].outcome.title).toBe(input.candidates[0].outcome.title);
    expect(parseOutcomeEnvelope(envelope).candidates[0].outcome.title).toBe(input.candidates[0].outcome.title);
  });

  it.each([257, 4_097])("rejects a %i-character title explicitly before filing", (length) => {
    const input = draft("plan");
    const envelope = structuredClone(createOutcomeEnvelope(input));
    input.candidates[0].outcome.title = "x".repeat(length);
    const raw = mutable(envelope);
    const candidate = (raw.candidates as Array<Record<string, unknown>>)[0];
    (candidate.outcome as Record<string, unknown>).title = input.candidates[0].outcome.title;
    const message = /outcome\.title must be at most 256 characters \(GitHub issue title limit\)/;
    expect(() => createOutcomeEnvelope(input)).toThrow(message);
    expect(() => parseOutcomeEnvelope(raw)).toThrow(message);
    expect(input.candidates[0].outcome.title).toHaveLength(length);
  });

  it.each([
    ["missing stable artifact ID", (raw: Record<string, unknown>) => {
      (raw.artifact as Record<string, unknown>).stableId = "";
    }],
    ["missing stable outcome ID", (raw: Record<string, unknown>) => {
      ((raw.candidates as Array<Record<string, unknown>>)[0]).stableOutcomeId = "";
    }],
    ["unknown producer kind", (raw: Record<string, unknown>) => {
      (raw.producer as Record<string, unknown>).kind = "meeting_notes";
    }],
    ["duplicate evidence IDs", (raw: Record<string, unknown>) => {
      const candidate = (raw.candidates as Array<Record<string, unknown>>)[0];
      const evidence = candidate.evidence as Array<Record<string, unknown>>;
      evidence.push(structuredClone(evidence[0]));
    }],
    ["unsupported confidence", (raw: Record<string, unknown>) => {
      const candidate = (raw.candidates as Array<Record<string, unknown>>)[0];
      const suggestions = candidate.suggestions as Record<string, Record<string, unknown>>;
      suggestions.type.confidence = "0.98";
    }],
    ["unsafe source locator", (raw: Record<string, unknown>) => {
      (raw.artifact as Record<string, unknown>).sourceLocator = "../../outside.json";
    }],
    ["mutable queue field", (raw: Record<string, unknown>) => {
      ((raw.candidates as Array<Record<string, unknown>>)[0]).queueStatus = "ready";
    }],
  ] as const)("rejects %s", (_label, mutateRaw) => {
    const raw = mutable(draft("plan"));
    mutateRaw(raw);
    expect(() => createOutcomeEnvelope(raw as unknown as OutcomeEnvelopeDraft)).toThrow();
  });

  it("enforces the Effort readiness gate", () => {
    const raw = draft("plan");
    raw.candidates[0].readiness.estimationSubstrate = false;
    expect(() => createOutcomeEnvelope(raw)).toThrow(/effort.*readiness/i);

    const mediumConfidence = draft("plan");
    mediumConfidence.candidates[0].suggestions.effort.confidence = "medium";
    expect(() => createOutcomeEnvelope(mediumConfidence)).toThrow(/effort.*high confidence/i);
  });

  it.each([
    ["organization identity", "organizationId", "org_123"],
    ["user identity", "userId", "user_123"],
    ["replay URL", "replayUrl", "https://session.example/replay/1"],
    ["attachment", "attachmentPath", "attachments/private.png"],
    ["lineage", "lineage", ["private-parent"]],
  ])("rejects future-user-bug %s", (_label, key, value) => {
    const raw = mutable(draft("future_user_bug"));
    ((raw.candidates as Array<Record<string, unknown>>)[0])[key] = value;
    expect(() => createOutcomeEnvelope(raw as unknown as OutcomeEnvelopeDraft))
      .toThrow(/future user bug|exact keys/i);
  });

  it("rejects URL and attachment-shaped future-user-bug locators", () => {
    for (const locator of ["https://example.test/replay/1", "attachments/private.png"]) {
      const raw = draft("future_user_bug");
      raw.candidates[0].evidence[0].sourceLocator = locator;
      expect(() => createOutcomeEnvelope(raw)).toThrow(/locator|future user bug/i);
    }
  });

  it("rejects tampered hashes instead of silently reminting parsed emissions", () => {
    const raw = mutable(createOutcomeEnvelope(draft("plan")));
    ((raw.candidates as Array<Record<string, unknown>>)[0]).emissionContentSha256 = SHA_B;
    expect(() => parseOutcomeEnvelope(raw)).toThrow(/emissionContentSha256/i);
  });
});

describe("source marker", () => {
  it("round-trips a canonical marker and stays distinct from current-main verification", () => {
    const envelope = createOutcomeEnvelope(draft("implementation_discovery"));
    const marker = renderSourceMarker(envelope, envelope.candidates[0]);
    expect(marker).toContain(SOURCE_MARKER);
    expect(parseSourceMarker(marker)).toMatchObject({
      sourceFingerprint: envelope.candidates[0].sourceFingerprint,
      emissionContentSha256: envelope.candidates[0].emissionContentSha256,
      producerKind: "implementation_discovery",
      stableArtifactId: "artifact:implementation-discovery",
      stableOutcomeId: "outcome-1",
    });
    expect(SOURCE_MARKER).not.toBe(VERIFICATION_MARKER);
    expect(() => parseSourceMarker(VERIFICATION_MARKER)).toThrow(/source marker/i);
  });

  it("requires exact marker keys and safe locators", () => {
    const envelope = createOutcomeEnvelope(draft("plan"));
    const valid = renderSourceMarker(envelope, envelope.candidates[0]);
    expect(() => parseSourceMarker(`${valid}\nqueue-status: ready`)).toThrow(/exact|source marker/i);
    expect(() => parseSourceMarker(valid.replace("docs/plans/plan.md", "https://example.test/plan")))
      .toThrow(/locator/i);
  });

  it.each([
    ["leading", "stable-artifact-id:  artifact:plan"],
    ["trailing", "stable-artifact-id: artifact:plan "],
  ])("rejects %s whitespace in a source marker value", (_position, modifiedLine) => {
    const envelope = createOutcomeEnvelope(draft("plan"));
    const valid = renderSourceMarker(envelope, envelope.candidates[0]);
    const modified = valid.replace("stable-artifact-id: artifact:plan", modifiedLine);
    expect(() => parseSourceMarker(modified)).toThrow(/single non-empty line/i);
  });
});

describe("candidate CLI", () => {
  it("validates a confined input and emits canonical output without GitHub access", () => {
    const repoRoot = mkdtempSync(resolve(tmpdir(), "example-repo-outcome-candidate-"));
    try {
      const inputRoot = resolve(repoRoot, "inputs");
      const artifactRoot = resolve(repoRoot, "artifacts/github-issue-roadmap");
      mkdirSync(inputRoot, { recursive: true });
      mkdirSync(artifactRoot, { recursive: true });
      const inputPath = resolve(inputRoot, "candidate.json");
      const outputPath = resolve(artifactRoot, "candidate.validated.json");
      const envelope = createOutcomeEnvelope(draft("ideation", 2));
      writeFileSync(inputPath, JSON.stringify(envelope), "utf8");

      const result = runCandidateCli([
        `--in=${inputPath}`,
        `--out=${outputPath}`,
      ], repoRoot);

      expect(result).toEqual({
        candidateCount: 2,
        producerKind: "ideation",
        outputPath,
        skipped: [],
      });
      expect(readFileSync(outputPath, "utf8")).toBe(outcomeEnvelopeJson(envelope));
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it.each([OUTCOME_ENVELOPE_SCHEMA_VERSION, OUTCOME_ENVELOPE_SCHEMA_VERSION_V2] as const)("derives a %s producer draft through the CLI", (schemaVersion) => {
    const repoRoot = mkdtempSync(resolve(tmpdir(), "example-repo-outcome-candidate-"));
    try {
      const inputRoot = resolve(repoRoot, "inputs");
      const artifactRoot = resolve(repoRoot, "artifacts/github-issue-roadmap");
      mkdirSync(inputRoot, { recursive: true });
      mkdirSync(artifactRoot, { recursive: true });
      const inputPath = resolve(inputRoot, "draft.json");
      const outputPath = resolve(artifactRoot, "draft.validated.json");

      // What a producer actually authors: semantic content, no fingerprint, no emission hash.
      const producerDraft = draft("implementation_discovery");
      producerDraft.schemaVersion = schemaVersion;
      if (schemaVersion === OUTCOME_ENVELOPE_SCHEMA_VERSION_V2) {
        producerDraft.candidates[0].acceptanceCriteria = ["The authored criterion survives candidate generation."];
      }
      expect(JSON.stringify(producerDraft)).not.toMatch(/sourceFingerprint|emissionContentSha256/);
      writeFileSync(inputPath, JSON.stringify(producerDraft), "utf8");

      const result = runCandidateCli([`--in=${inputPath}`, `--out=${outputPath}`], repoRoot);
      expect(result.producerKind).toBe("implementation_discovery");
      // The emitted envelope is byte-identical to deriving it directly.
      expect(readFileSync(outputPath, "utf8")).toBe(outcomeEnvelopeJson(createOutcomeEnvelope(producerDraft)));
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("refuses a candidate whose supplied fingerprint or emission hash was not derived from its content", () => {
    const repoRoot = mkdtempSync(resolve(tmpdir(), "example-repo-outcome-candidate-"));
    try {
      const inputRoot = resolve(repoRoot, "inputs");
      const artifactRoot = resolve(repoRoot, "artifacts/github-issue-roadmap");
      mkdirSync(inputRoot, { recursive: true });
      mkdirSync(artifactRoot, { recursive: true });
      const outputPath = resolve(artifactRoot, "forged.validated.json");
      const honest = createOutcomeEnvelope(draft("plan"));

      const forgedFingerprint = {
        ...honest,
        candidates: honest.candidates.map((candidate) => ({ ...candidate, sourceFingerprint: "f".repeat(64) })),
      };
      const fingerprintPath = resolve(inputRoot, "forged-fingerprint.json");
      writeFileSync(fingerprintPath, JSON.stringify(forgedFingerprint), "utf8");
      expect(() => runCandidateCli([`--in=${fingerprintPath}`, `--out=${outputPath}`], repoRoot))
        .toThrow(/sourceFingerprint does not match/i);

      const forgedEmission = {
        ...honest,
        candidates: honest.candidates.map((candidate) => ({ ...candidate, emissionContentSha256: "e".repeat(64) })),
      };
      const emissionPath = resolve(inputRoot, "forged-emission.json");
      writeFileSync(emissionPath, JSON.stringify(forgedEmission), "utf8");
      expect(() => runCandidateCli([`--in=${emissionPath}`, `--out=${outputPath}`], repoRoot))
        .toThrow(/emissionContentSha256 does not match/i);

      expect(existsSync(outputPath)).toBe(false);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("rejects input escape and input/output aliasing", () => {
    const repoRoot = mkdtempSync(resolve(tmpdir(), "example-repo-outcome-candidate-"));
    const outsideRoot = mkdtempSync(resolve(tmpdir(), "example-repo-outcome-outside-"));
    try {
      const artifactRoot = resolve(repoRoot, "artifacts/github-issue-roadmap");
      mkdirSync(artifactRoot, { recursive: true });
      const outside = resolve(outsideRoot, "candidate.json");
      const output = resolve(artifactRoot, "candidate.json");
      writeFileSync(outside, JSON.stringify(createOutcomeEnvelope(draft("plan"))), "utf8");
      writeFileSync(output, JSON.stringify(createOutcomeEnvelope(draft("plan"))), "utf8");
      expect(() => runCandidateCli([`--in=${outside}`, `--out=${output}`], repoRoot))
        .toThrow(/inside the repository/i);
      expect(() => runCandidateCli([`--in=${output}`, `--out=${output}`], repoRoot))
        .toThrow(/same file/i);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});
