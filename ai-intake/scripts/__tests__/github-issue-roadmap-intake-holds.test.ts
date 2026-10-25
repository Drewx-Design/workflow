import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  formatIntakeHoldList, listIntakeHolds, resolveIntakeHold, runIntakeHoldsCli,
} from "../github-issue-roadmap-intake-holds";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "roadmap-intake-holds-"));
  const drainsRoot = join(root, "artifacts", "github-issue-roadmap", "drains");
  const resolutionLogPath = join(root, "artifacts", "github-issue-roadmap", "hold-resolutions.jsonl");
  mkdirSync(drainsRoot, { recursive: true });
  return { root, drainsRoot, resolutionLogPath };
}

function addRun(input: {
  root: string;
  runId: string;
  preparedAt: string;
  decisionHash: string;
  candidates: readonly { fingerprint: string; presentation: "draft" | "hold"; rationale?: string; locator?: string }[];
  malformedDisposition?: boolean;
}) {
  const runRoot = join(input.root, "artifacts", "github-issue-roadmap", "drains", input.runId);
  const processedDirectory = join(input.root, "queue", "processed", input.runId);
  const planPath = join(runRoot, "approval-plan.json");
  mkdirSync(runRoot, { recursive: true });
  mkdirSync(processedDirectory, { recursive: true });
  writeFileSync(join(processedDirectory, "mixed--candidate.json.dispositions.json"), input.malformedDisposition
    ? "{broken"
    : `${JSON.stringify({
      candidates: input.candidates.map((candidate) => ({
        sourceFingerprint: candidate.fingerprint, presentation: candidate.presentation,
      })),
    }, null, 2)}\n`, "utf8");
  const queueEntries = input.candidates.map((candidate) => ({
    path: join(input.root, "queue", "candidate.json"),
    sourceLocator: candidate.locator ?? `docs/plans/${candidate.fingerprint}.md`,
    sourceFingerprints: [candidate.fingerprint],
  }));
  writeFileSync(join(runRoot, "manifest.json"), `${JSON.stringify({
    schemaVersion: "github-issue-roadmap-intake-drain/v1",
    runId: input.runId,
    preparedAt: input.preparedAt,
    approvalPlanPath: planPath,
    processedDirectory,
    envelopes: [{ queueEntries }],
  }, null, 2)}\n`, "utf8");
  writeFileSync(planPath, `${JSON.stringify({
    schemaVersion: "github-issue-roadmap-intake-approval-plan/v1",
    generatedAt: input.preparedAt,
    entries: input.candidates.map((candidate) => ({
      decisionReport: { path: join(runRoot, "decision.json"), contentSha256: input.decisionHash },
      sourceFingerprint: candidate.fingerprint,
      presentation: candidate.presentation,
      hold: candidate.presentation === "hold" ? {
        reason: "plausible_overlap",
        rationale: candidate.rationale ?? `Rationale for ${candidate.fingerprint}`,
        competingIssueNumbers: [1678, 1699],
        competingIssues: [],
        evidenceIds: [],
      } : null,
    })),
  }, null, 2)}\n`, "utf8");
  return { planPath, processedDirectory };
}

describe("roadmap intake hold inbox", () => {
  it("surfaces abandoned and corrupt runs without hiding another run's hold", () => {
    const test = fixture();
    addRun({ ...test, runId: "healthy", preparedAt: "2026-09-01T12:00:00.000Z", decisionHash: HASH_A,
      candidates: [{ fingerprint: "visible", presentation: "hold" }] });
    const abandoned = join(test.drainsRoot, "abandoned");
    mkdirSync(join(abandoned, "quarantine"), { recursive: true });
    writeFileSync(join(abandoned, "quarantine/admission.json.reason.txt"), "deterministic failure\n");
    writeFileSync(join(abandoned, "abandoned.json"), JSON.stringify({
      runId: "abandoned", reason: "deterministic failure",
      originalPath: "artifacts/github-issue-roadmap/drains/abandoned/admission.json",
      quarantinedPath: "artifacts/github-issue-roadmap/drains/abandoned/quarantine/admission.json",
      reasonPath: "artifacts/github-issue-roadmap/drains/abandoned/quarantine/admission.json.reason.txt",
      sidecars: [{ originalPath: "queue/candidate.json", quarantinedPath: "artifacts/github-issue-roadmap/drains/abandoned/quarantine/sidecars/0.json" }],
    }));
    const output = runIntakeHoldsCli({ repoRoot: test.root, argv: ["list"] });
    expect(output).toContain("visible");
    expect(output).toContain("deterministic failure");
    expect(output).toContain("quarantine/sidecars/0.json");
    mkdirSync(join(test.drainsRoot, "corrupt"));
    writeFileSync(join(test.drainsRoot, "corrupt/admission.json"), "{torn");
    const degraded = runIntakeHoldsCli({ repoRoot: test.root, argv: ["list"] });
    expect(degraded).toContain("visible");
    expect(degraded).toContain("corrupt run, needs manual attention");
    expect(degraded).toContain("deterministic failure");
  });
  it("refuses an absent drains root instead of reporting an empty hold list", () => {
    const test = fixture();
    expect(() => listIntakeHolds({ ...test, drainsRoot: join(test.root, "absent") })).toThrow(/unavailable: absent/);
  });

  it("lists the held candidate from a mixed sidecar using the approval plan rationale", () => {
    const test = fixture();
    addRun({
      ...test, runId: "drain-mixed", preparedAt: "2026-08-30T12:00:00.000Z", decisionHash: HASH_A,
      candidates: [
        { fingerprint: "drafted-fingerprint", presentation: "draft" },
        { fingerprint: "held-fingerprint", presentation: "hold", rationale: "The plan-only overlap rationale." },
      ],
    });

    const holds = listIntakeHolds(test);
    const output = formatIntakeHoldList(holds);

    expect(holds.map((hold) => hold.sourceFingerprint)).toEqual(["held-fingerprint"]);
    expect(output).toContain("The plan-only overlap rationale.");
    expect(output).toContain("docs/plans/held-fingerprint.md");
    expect(output).toContain("#1678, #1699");
    expect(output).toContain("Total: 1");
  });

  it("removes only the resolved hold while another hold from the run remains", () => {
    const test = fixture();
    addRun({
      ...test, runId: "drain-two", preparedAt: "2026-08-31T12:00:00.000Z", decisionHash: HASH_A,
      candidates: [
        { fingerprint: "resolved-fingerprint", presentation: "hold" },
        { fingerprint: "unresolved-fingerprint", presentation: "hold" },
      ],
    });
    resolveIntakeHold({
      ...test, decisionContentSha256: HASH_A, sourceFingerprint: "resolved-fingerprint",
      outcome: "accepted-existing", acceptedExistingIssueNumber: 1678, now: new Date("2026-09-02T12:00:00.000Z"),
    });

    expect(listIntakeHolds(test).map((hold) => hold.sourceFingerprint)).toEqual(["unresolved-fingerprint"]);
    expect(readFileSync(test.resolutionLogPath, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("tracks the same fingerprint in different drain decisions separately and sorts oldest first", () => {
    const test = fixture();
    addRun({
      ...test, runId: "drain-new", preparedAt: "2026-09-01T12:00:00.000Z", decisionHash: HASH_B,
      candidates: [{ fingerprint: "same-fingerprint", presentation: "hold" }],
    });
    addRun({
      ...test, runId: "drain-old", preparedAt: "2026-08-29T12:00:00.000Z", decisionHash: HASH_A,
      candidates: [{ fingerprint: "same-fingerprint", presentation: "hold" }],
    });
    expect(listIntakeHolds(test).map((hold) => hold.runId)).toEqual(["drain-old", "drain-new"]);

    resolveIntakeHold({
      ...test, decisionContentSha256: HASH_A, sourceFingerprint: "same-fingerprint", outcome: "override",
    });
    expect(listIntakeHolds(test).map((hold) => [hold.runId, hold.decisionContentSha256])).toEqual([
      ["drain-new", HASH_B],
    ]);
  });

  it("refuses an unknown fingerprint and a resolution kind outside the terminal three", () => {
    const test = fixture();
    addRun({
      ...test, runId: "drain-one", preparedAt: "2026-09-01T12:00:00.000Z", decisionHash: HASH_A,
      candidates: [{ fingerprint: "known-fingerprint", presentation: "hold" }],
    });
    expect(() => resolveIntakeHold({
      ...test, decisionContentSha256: HASH_A, sourceFingerprint: "unknown-fingerprint", outcome: "override",
    })).toThrow(/unknown or already resolved hold/i);
    expect(() => resolveIntakeHold({
      ...test, decisionContentSha256: HASH_A, sourceFingerprint: "known-fingerprint", outcome: "dismissed",
    })).toThrow(/unsupported hold resolution kind/i);
  });

  it("requires outcome-specific details", () => {
    const test = fixture();
    addRun({
      ...test, runId: "drain-details", preparedAt: "2026-09-01T12:00:00.000Z", decisionHash: HASH_A,
      candidates: [{ fingerprint: "known-fingerprint", presentation: "hold" }],
    });
    expect(() => resolveIntakeHold({
      ...test, decisionContentSha256: HASH_A, sourceFingerprint: "known-fingerprint", outcome: "accepted-existing",
    })).toThrow(/positive integer/i);
    expect(() => resolveIntakeHold({
      ...test, decisionContentSha256: HASH_A, sourceFingerprint: "known-fingerprint", outcome: "resubmitted",
    })).toThrow(/non-empty text/i);
  });

  it("prints a clean empty state and exits through the CLI contract", () => {
    const test = fixture();
    expect(runIntakeHoldsCli({
      repoRoot: test.root,
      argv: ["list", `--drains=${test.drainsRoot}`, `--resolution-log=${test.resolutionLogPath}`],
    })).toBe("No unresolved roadmap intake holds.\nTotal: 0");
  });

  it("surfaces malformed plans and unreadable dispositions by filename", () => {
    const malformedPlan = fixture();
    const first = addRun({
      ...malformedPlan, runId: "drain-plan", preparedAt: "2026-09-01T12:00:00.000Z", decisionHash: HASH_A,
      candidates: [{ fingerprint: "known-fingerprint", presentation: "hold" }],
    });
    writeFileSync(first.planPath, "{broken", "utf8");
    expect(listIntakeHolds(malformedPlan)[0].rationale).toContain(first.planPath);

    const malformedDisposition = fixture();
    const second = addRun({
      ...malformedDisposition, runId: "drain-disposition", preparedAt: "2026-09-01T12:00:00.000Z", decisionHash: HASH_A,
      candidates: [{ fingerprint: "known-fingerprint", presentation: "hold" }], malformedDisposition: true,
    });
    const dispositionPath = join(second.processedDirectory, "mixed--candidate.json.dispositions.json");
    expect(listIntakeHolds(malformedDisposition)[0].rationale).toContain(dispositionPath);
  });
});
