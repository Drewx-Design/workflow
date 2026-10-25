import { existsSync, fsyncSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, uptime } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildIntakeApprovalPlan,
  runIntakeApproveCli,
  sha256Content,
  type IntakeApprovalPlan,
} from "../github-issue-roadmap-intake-approve";
import {
  applyIntakeApprovalPlan,
  IntakeExecutionBreaker,
  runIntakeApplyCli,
  type OperatorIntakeApprovalTransport,
} from "../github-issue-roadmap-intake-apply";
import * as durableSeam from "../github-issue-roadmap-intake-apply";
import { runIntakeResolveCli } from "../github-issue-roadmap-intake-resolve";
import capabilities from "../github-issue-roadmap-capabilities.json";
import type { ActionQualificationContext } from "../lib/github-issue-roadmap/action-qualification";
import { parseDispatcherCapabilityManifest } from "../lib/github-issue-roadmap/capability-manifest";
import { probeExistenceAtSha } from "../github-issue-roadmap-existence-probe";
import { canonicalJsonSha256 } from "../lib/github-issue-roadmap/canonical-json";
import type { DispositionHistory } from "../lib/github-issue-roadmap/disposition-history";
import { runIntakeShadow } from "../lib/github-issue-roadmap/intake-shadow";
import { createOutcomeEnvelope, parseOutcomeEnvelope } from "../lib/github-issue-roadmap/outcome-candidate";
import { createExistenceRecord } from "../lib/github-issue-roadmap/existence-record";
import { createGitHubIntakeApprovalTransport } from "../lib/github-issue-roadmap/github-intake-approval-transport";
import { buildIntakeStack, censusPass, stackSnapshot, STACK_ORIGIN_MAIN_SHA } from "./__helpers__/roadmap-intake-stack";
import { evidenceAssessment, reboundSnapshot } from "./__helpers__/roadmap-run-evidence";
import { buildRunEvidence, verifyRunEvidence } from "../lib/github-issue-roadmap/intake-run-evidence";
import { acquireExecutionClaim, importLegacyLedgers, JournalWriteError, readJournal, resolveJournalPath } from "../lib/github-issue-roadmap/intake-execution-journal";
import { parseIntakeSnapshotV1 } from "../lib/github-issue-roadmap/intake-snapshot";
import { parseSourceMarker } from "../lib/github-issue-roadmap/source-marker";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), readFileSync: vi.fn(fs.readFileSync), renameSync: vi.fn(fs.renameSync) };
});

let journalRoot: string;
let previousExitCode: typeof process.exitCode;
beforeEach(() => {
  previousExitCode = process.exitCode;
  journalRoot = mkdtempSync(join(tmpdir(), "roadmap-approval-journal-"));
  vi.stubEnv("ROADMAP_INTAKE_JOURNAL_ROOT", journalRoot);
});
afterEach(() => {
  process.exitCode = previousExitCode;
  vi.mocked(fsyncSync).mockReset();
  vi.mocked(readFileSync).mockReset();
  vi.mocked(renameSync).mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(journalRoot, { recursive: true, force: true });
});

const NOW = new Date("2026-08-31T18:00:00.000Z");
const VERIFIED_ORIGIN_MAIN_SHA = "e".repeat(40);
const ADVANCED_SHA = "f".repeat(40);
// Explicit test-only authority keeps downstream close/ownership assertions reachable.
// Production authority remains disabled and is tested without this context below.
const LEGACY_CLOSE_QUALIFICATION: ActionQualificationContext = {
  manifest: parseDispatcherCapabilityManifest({ ...capabilities,
    capabilities: capabilities.capabilities.map(entry => entry.actionKinds.includes("close_issue")
      ? { ...entry, entrypoint: "automatic", enabled: true, qualification: "production" } : entry),
  }),
};
const ENVELOPE = createOutcomeEnvelope({
  schemaVersion: "github-issue-roadmap-outcome-envelope/v1",
  repository: { organization: "example-org", name: "example-repo", databaseId: 1, nodeId: "R_1" },
  producer: { kind: "plan", version: "1" },
  artifact: { stableId: "example", revisionSha256: "a".repeat(64), sourceLocator: "docs/plans/example.md" },
  candidates: ["create", "append", "hold"].map((id) => ({
    stableOutcomeId: id,
    outcome: { title: `Outcome ${id}`, completionRule: `Contains src/${id}.ts`, affectedSystems: ["roadmap"] },
    evidence: [{ id: "source", kind: "source_artifact", sourceLocator: "docs/plans/example.md", contentSha256: "a".repeat(64) }],
    provenance: [{ id: "source", sourceLocator: "docs/plans/example.md", contentSha256: "a".repeat(64) }],
    readiness: { independentlyCloseable: true, framingComplete: true, completionRuleDefined: true,
      evidenceSufficient: true, estimationSubstrate: true, unresolvedDecisionIds: [], dependencyIds: [],
      currentMainVerificationEvidenceId: null },
    relationshipCandidates: [],
    suggestions: Object.fromEntries(["type", "priority", "effort"].map((key) => [key,
      { value: null, confidence: "low", rationale: "Operator decides." }])),
  })),
});
const CREATE_FINGERPRINT = ENVELOPE.candidates.find((entry) => entry.stableOutcomeId === "create")!.sourceFingerprint;
const APPEND_FINGERPRINT = ENVELOPE.candidates.find((entry) => entry.stableOutcomeId === "append")!.sourceFingerprint;
const HOLD_FINGERPRINT = ENVELOPE.candidates.find((entry) => entry.stableOutcomeId === "hold")!.sourceFingerprint;
const CANDIDATE_CONTENT = `${JSON.stringify(ENVELOPE)}\n`;
const EVIDENCE_CENSUS = stackSnapshot(ENVELOPE, { ...censusPass(), repository: ENVELOPE.repository });
const EVIDENCE_ASSESSMENT = evidenceAssessment(ENVELOPE, EVIDENCE_CENSUS);
function distinctEnvelope() {
  return createOutcomeEnvelope({
    schemaVersion: "github-issue-roadmap-outcome-envelope/v1",
    repository: ENVELOPE.repository, producer: ENVELOPE.producer,
    artifact: { ...ENVELOPE.artifact, stableId: "different-example" },
    candidates: ENVELOPE.candidates.map(({ sourceFingerprint: _source, emissionContentSha256: _emission, ...candidate }) => ({
      ...candidate, stableOutcomeId: `${candidate.stableOutcomeId}-different`,
    })),
  });
}
function fakeGit(_cwd: string, args: readonly string[]): string {
  if (args[0] === "rev-parse" && args.includes("--is-shallow-repository")) return "false";
  if (args[0] === "rev-parse") return args[2].replace("^{commit}", "");
  if (args[0] === "ls-tree") return "";
  throw new Error(`Unexpected git command: ${args.join(" ")}`);
}
function emptyDispositionHistory(): DispositionHistory {
  return new Map();
}
const BOUND_EXISTENCE = probeExistenceAtSha({
  dispositionHistory: emptyDispositionHistory,
  envelope: ENVELOPE, originMainSha: VERIFIED_ORIGIN_MAIN_SHA, repoRoot: ".", runGit: fakeGit,
  budget: Number.MAX_SAFE_INTEGER, generatedAt: NOW.toISOString(),
});
const EXISTENCE_CONTENT_SHA256 = BOUND_EXISTENCE.contentSha256;

function marker(fingerprint: string): string {
  return [
    "<!-- github-issue-roadmap-source:v1 -->",
    `source-fingerprint: ${fingerprint}`,
    `emission-content-sha256: ${fingerprint.split("").reverse().join("")}`,
    "producer-kind: plan",
    "producer-version: 1",
    `stable-artifact-id: artifact-${fingerprint[0]}`,
    `stable-outcome-id: outcome-${fingerprint[0]}`,
    "source-locator: docs/plans/example.md",
  ].join("\n");
}

function draft(fingerprint: string, action: "create_issue" | "append_evidence", issueNumber: number | null) {
  const sourceMarker = marker(fingerprint);
  return {
    sourceFingerprint: fingerprint,
    repository: "example-org/example-repo",
    intendedAction: action,
    intendedActions: [action],
    canonicalIssueNumber: issueNumber,
    closeIssue: null,
    primaryAction: null,
    issue: { title: `Outcome ${fingerprint[0]}`, body: `## Outcome\nClose independently.\n\n${sourceMarker}` },
    marker: sourceMarker,
    evidenceLines: ["source_artifact: docs/plans/example.md"],
    evidenceComment: `## Additive roadmap evidence\n- source_artifact: docs/plans/example.md\n\n${sourceMarker}`,
    issueType: "Task",
    authorizedClassification: [],
    deniedClassification: action === "create_issue" ? [{
      action: "set_type", fieldName: "Type", value: "Task", disposition: "recommendation_only",
      rationale: "This outcome is independently closeable work.", confidence: "high", deniedReason: "Approval required.",
    }, {
      action: "set_priority", fieldName: "Priority", value: "P2", disposition: "recommendation_only",
      rationale: "The evidence establishes material impact.", confidence: "medium", deniedReason: "Approval required.",
    }, {
      action: "set_effort", fieldName: "Effort", value: "Medium", disposition: "recommendation_only",
      rationale: "The work spans a bounded integration.", confidence: "low", deniedReason: "Approval required.",
    }] : [],
  };
}

function report() {
  return {
    schemaVersion: "github-issue-roadmap-intake-shadow/v1",
    generatedAt: NOW.toISOString(),
    repository: { organization: "example-org", name: "example-repo" },
    decision: {
      candidateSha256: canonicalJsonSha256(parseOutcomeEnvelope(JSON.parse(CANDIDATE_CONTENT))),
      snapshotContentSha256: EVIDENCE_CENSUS.contentSha256,
      assessmentSha256: canonicalJsonSha256(EVIDENCE_ASSESSMENT),
      existenceRecordContentSha256: EXISTENCE_CONTENT_SHA256,
      verifiedOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA,
      candidates: [{
        sourceFingerprint: CREATE_FINGERPRINT,
        actions: [{ action: "set_horizon", proposed: "Later", confidence: "low", rationale: "No urgent sequence is established." }],
      }, { sourceFingerprint: APPEND_FINGERPRINT, actions: [] }, { sourceFingerprint: HOLD_FINGERPRINT, actions: [] }],
    },
    candidates: [{
      sourceFingerprint: CREATE_FINGERPRINT, matchResult: "clearly_novel", presentation: "draft",
      draft: draft(CREATE_FINGERPRINT, "create_issue", null), hold: null, intendedButDenied: [],
    }, {
      sourceFingerprint: APPEND_FINGERPRINT, matchResult: "exact_match", presentation: "draft",
      draft: draft(APPEND_FINGERPRINT, "append_evidence", 42), hold: null, intendedButDenied: [],
    }, {
      sourceFingerprint: HOLD_FINGERPRINT, matchResult: "plausible_overlap", presentation: "hold", draft: null,
      hold: {
        reason: "plausible_overlap", competingIssueNumbers: [9],
        issue: {
          title: "Held outcome",
          body: `## Outcome\nClose independently.\n\n## Unresolved classification\nOverlap is unresolved.\n\n${marker(HOLD_FINGERPRINT)}`,
        },
        competingIssues: [{ number: 9, title: "Existing outcome", state: "OPEN", updatedAt: "2026-08-30T12:00:00.000Z" }],
        evidenceIds: ["issue:9"], rationale: "Overlap is unresolved.",
      },
      intendedButDenied: [],
    }],
  };
}

function writeRunEvidenceFixture(planPath: string, census = EVIDENCE_CENSUS, allowInvalidPlan = false): string {
  const root = dirname(planPath);
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as IntakeApprovalPlan;
  const write = (path: string, value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    writeFileSync(join(root, path), bytes);
    return { path, bytes };
  };
  const candidates = [ENVELOPE];
  for (const name of readdirSync(root).filter((name) => name.includes("candidate") && name.endsWith(".json"))) {
    try { candidates.push(parseOutcomeEnvelope(JSON.parse(readFileSync(join(root, name), "utf8")))); }
    catch { /* Deliberately invalid CLI candidate fixtures are tested separately from retained evidence. */ }
  }
  const decisions = plan.decisions.map((binding, index) => {
    const content = readFileSync(binding.path);
    const source = JSON.parse(content.toString("utf8"));
    const envelope = candidates.find((candidate) => canonicalJsonSha256(candidate) === source.decision.candidateSha256)!;
    if (!envelope) throw new Error("Fixture is missing its bound candidate.");
    const snapshot = reboundSnapshot(census, envelope);
    const assessment = evidenceAssessment(envelope, snapshot);
    return { decision: { path: basename(binding.path), bytes: content },
      candidate: write(`evidence-candidate-${index}.json`, envelope), snapshot: write(`evidence-snapshot-${index}.json`, snapshot),
      assessment: write(`evidence-assessment-${index}.json`, assessment) };
  });
  const built = buildRunEvidence({ runId: "test-run", repository: "example-org/example-repo", preparedAt: NOW.toISOString(),
    approvalPlan: { path: basename(planPath), bytes: readFileSync(planPath) }, census: write("census.json", census), decisions });
  if (!built.ok) {
    if (allowInvalidPlan) return join(root, "run-evidence.json");
    throw new Error(`Fixture evidence: ${built.reason}: ${built.detail}`);
  }
  write("run-evidence.json", built.evidence);
  return join(root, "run-evidence.json");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "roadmap-intake-approval-"));
  const decisionPath = join(root, "decision.json");
  const planPath = join(root, "approval.json");
  const journalPath = resolveJournalPath("example-org/example-repo");
  mkdirSync(dirname(journalPath), { recursive: true });
  const candidatePath = join(root, "candidate.json");
  const existencePath = join(root, "existence.json");
  writeFileSync(candidatePath, CANDIDATE_CONTENT, "utf8");
  writeFileSync(existencePath, JSON.stringify(BOUND_EXISTENCE), "utf8");
  const decisionContent = `${JSON.stringify(report(), null, 2)}\n`;
  writeFileSync(decisionPath, decisionContent, "utf8");
  const plan = buildIntakeApprovalPlan({ decisionPath, decisionContent, now: NOW });
  const persistPlan = () => {
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    writeRunEvidenceFixture(planPath, EVIDENCE_CENSUS, true);
  };
  persistPlan();
  const runEvidencePath = join(root, "run-evidence.json");
  const execution = { runEvidencePath, candidatePaths: [candidatePath], existencePaths: [existencePath], repoRoot: root, runGit: fakeGit,
    dispositionHistory: emptyDispositionHistory };
  return { root, decisionPath, decisionContent, planPath, journalPath, plan, persistPlan, candidatePath, existencePath, runEvidencePath, execution };
}

describe("apply run-evidence gate", () => {
  const required = "Execution requires --run-evidence=<path> produced by the drain run that generated this plan.";
  function untouched(value: ReturnType<typeof fixture>, runGit: ReturnType<typeof vi.fn>, openTransport: ReturnType<typeof vi.fn>) {
    expect(runGit).not.toHaveBeenCalled();
    expect(openTransport).not.toHaveBeenCalled();
    expect(fsyncSync).not.toHaveBeenCalled();
    expect(renameSync).not.toHaveBeenCalled();
    expect(existsSync(value.journalPath)).toBe(false);
    expect(existsSync(join(dirname(value.journalPath), "execution.lock"))).toBe(false);
  }

  it.each(["API", "CLI"])("requires evidence before a claim, Git or transport (%s)", async (entryPoint) => {
    const value = fixture();
    const runGit = vi.fn(fakeGit);
    const openTransport = vi.fn(fakeTransport);
    const result = entryPoint === "API"
      ? applyIntakeApprovalPlan({ planPath: value.planPath, execute: true, trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, runGit, openTransport })
      : runIntakeApplyCli({ argv: [`--plan=${value.planPath}`, "--execute", `--origin-main-sha=${VERIFIED_ORIGIN_MAIN_SHA}`],
        runGit, openTransport });
    await expect(result).rejects.toThrow(new Error(required));
    untouched(value, runGit, openTransport);
  });

  it.each([false, true])("refuses a tampered census before any side effect (execute=%s)", async (execute) => {
    const value = fixture();
    const census = join(value.root, "census.json");
    writeFileSync(census, readFileSync(census, "utf8") + "\n");
    const runGit = vi.fn(fakeGit);
    const openTransport = vi.fn(fakeTransport);
    await expect(runIntakeApplyCli({
      argv: [`--plan=${value.planPath}`, `--run-evidence=${value.runEvidencePath}`,
        ...(execute ? ["--execute", `--origin-main-sha=${VERIFIED_ORIGIN_MAIN_SHA}`] : [])],
      operatorToken: execute ? "test-token" : undefined, runGit, openTransport,
    })).rejects.toThrow(/^census_hash: /);
    untouched(value, runGit, openTransport);
  });

  it.each([false, true])("exposes verified evidence and both census timestamps (execute=%s)", async (execute) => {
    const value = fixture();
    value.plan.entries[0].approved = true;
    value.persistPlan();
    const expected = verifyRunEvidence({ evidenceBytes: readFileSync(value.runEvidencePath), plan: value.plan,
      files: (name) => readFileSync(join(value.root, name)), repository: "example-org/example-repo" });
    if (!expected.ok) throw new Error(expected.reason);
    const transport = fakeTransport();
    const result = await applyIntakeApprovalPlan({ ...value.execution, planPath: value.planPath, execute,
      trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, transport, now: NOW });
    const census = expected.evidence.census;
    expect(result.runEvidence).toEqual({ path: "run-evidence.json", artifactSha256: sha256Content(readFileSync(value.runEvidencePath)),
      runId: "test-run", census: { basename: "census.json", artifactSha256: census.artifactSha256, contentSha256: census.contentSha256,
        coverageSha256: census.coverageSha256, startedAt: EVIDENCE_CENSUS.census.completedAt,
        bookendCompletedAt: EVIDENCE_CENSUS.census.bookendCompletedAt } });
    expect(transport.createIssue).toHaveBeenCalledTimes(execute ? 1 : 0);
    expect(JSON.stringify(result.runEvidence)).not.toContain(value.root);
  });

  it.each(["ENOENT", "EACCES"])("names unreadable evidence without disclosing an absolute path (%s)", async (code) => {
    const value = fixture();
    if (code === "ENOENT") unlinkSync(value.runEvidencePath);
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    if (code === "EACCES") vi.mocked(readFileSync).mockImplementation(((path, ...args) => {
      if (path === value.runEvidencePath) throw Object.assign(new Error(`Access denied: ${value.runEvidencePath}`), { code });
      return fs.readFileSync(path, ...args);
    }) as typeof readFileSync);
    const runGit = vi.fn(fakeGit);
    const openTransport = vi.fn(fakeTransport);
    await expect(runIntakeApplyCli({ argv: [`--plan=${value.planPath}`, "--execute",
      `--origin-main-sha=${VERIFIED_ORIGIN_MAIN_SHA}`, `--run-evidence=${value.runEvidencePath}`], runGit, openTransport }))
      .rejects.toThrow(new Error(`run_evidence_unreadable: run-evidence.json (${code})`));
    untouched(value, runGit, openTransport);
  });

  it("refuses an evidence sibling junction or symlink that escapes the physical run root", async (context) => {
    const value = fixture();
    const outside = mkdtempSync(join(tmpdir(), "roadmap-evidence-outside-"));
    const censusPath = join(value.root, "census.json");
    unlinkSync(censusPath);
    try { symlinkSync(outside, censusPath, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) {
      context.skip(`Platform refused junction/symlink creation: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
      return;
    }
    const runGit = vi.fn(fakeGit);
    const openTransport = vi.fn(fakeTransport);
    try {
      await expect(runIntakeApplyCli({ argv: [`--plan=${value.planPath}`, "--execute",
        `--origin-main-sha=${VERIFIED_ORIGIN_MAIN_SHA}`, `--run-evidence=${value.runEvidencePath}`], runGit, openTransport }))
        .rejects.toThrow(new Error("path_escape: census.json"));
      untouched(value, runGit, openTransport);
    } finally { unlinkSync(censusPath); }
  });

  it("requires refreshing evidence after an approval edit", async () => {
    const value = fixture();
    value.plan.entries[0].approved = true;
    writeFileSync(value.planPath, JSON.stringify(value.plan));
    await expect(applyIntakeApprovalPlan({ ...value.execution, planPath: value.planPath })).rejects.toThrow(/^plan_binding: /);
    writeRunEvidenceFixture(value.planPath);
    await expect(applyIntakeApprovalPlan({ ...value.execution, planPath: value.planPath })).resolves.toMatchObject({ mode: "dry-run" });
  });

  it.each(["--run-evidence=", "--run-evidence=duplicate.json"])("refuses an empty or repeated flag (%s)", async (flag) => {
    const value = fixture();
    const runGit = vi.fn(fakeGit);
    const openTransport = vi.fn(fakeTransport);
    await expect(runIntakeApplyCli({ argv: [`--plan=${value.planPath}`, `--run-evidence=${value.runEvidencePath}`, flag],
      runGit, openTransport })).rejects.toThrow(`Unsupported or duplicate argument: ${flag}`);
    untouched(value, runGit, openTransport);
  });

  it.each([false, true].flatMap((evidence) => [false, true].flatMap((tampered) =>
    ["conflicting modes", "ledger", "SHA", "token"].map((stage) => ({ evidence, tampered, stage })))))(
    "preserves invocation refusal order (evidence=$evidence, tampered=$tampered, stage=$stage)", async ({ evidence, tampered, stage }) => {
      const value = fixture();
      if (tampered) writeFileSync(join(value.root, "census.json"), readFileSync(join(value.root, "census.json"), "utf8") + "\n");
      const runGit = vi.fn(fakeGit);
      const openTransport = vi.fn(fakeTransport);
      const flags = stage === "conflicting modes" ? ["--import-ledger=unused.json"] : stage === "ledger" ? ["--ledger=unused.json"] : [];
      const result = runIntakeApplyCli({ argv: [`--plan=${value.planPath}`, "--execute", ...flags,
        ...(evidence ? [`--run-evidence=${value.runEvidencePath}`] : []),
        ...(stage === "token" ? [`--origin-main-sha=${VERIFIED_ORIGIN_MAIN_SHA}`] : [])], runGit, openTransport });
      const message = stage === "conflicting modes" ? /--execute cannot be combined with --import-ledger/
        : stage === "ledger" ? /--ledger is not supported in execute mode/
        : stage === "SHA" ? /Execute mode requires --origin-main-sha/
        : !evidence ? new Error(required) : tampered ? /^census_hash: / : /Set ROADMAP_SHADOW_PUBLISH_TOKEN only/;
      await expect(result).rejects.toThrow(message);
      untouched(value, runGit, openTransport);
    });
});

function fakeTransport(): OperatorIntakeApprovalTransport {
  return {
    preflightClassifications: vi.fn(async () => undefined),
    createIssue: vi.fn(async () => ({ issueNumber: 101, issueId: "I_101" })),
    appendEvidenceComment: vi.fn(async () => ({ commentId: "IC_202" })),
    closeIssue: vi.fn(async () => undefined),
    applyClassification: vi.fn(async () => ({ identifier: "field-write" })),
    verifyClassifications: vi.fn(async () => true),
  };
}

function durableEvent(event: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "github-issue-roadmap-intake-approval-ledger/v1",
    event, appliedAt: NOW.toISOString(), repository: "example-org/example-repo",
    sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue",
    emissionContentSha256: "a".repeat(64), decisionContentSha256: "b".repeat(64),
    payload: { issue: draft(CREATE_FINGERPRINT, "create_issue", null).issue, evidenceComment: null, closeIssue: null },
    classifications: [{ fieldName: "Priority", value: "P2" }],
    issueNumber: event === "complete" ? 101 : null,
    issueId: event === "complete" ? "I_101" : null, commentId: null,
    ...overrides,
  };
}

function legacyExecution(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "github-issue-roadmap-intake-approval-ledger/v1",
    mode: "execute", executed: true, disposition: "executed",
    repository: "example-org/example-repo", sourceFingerprint: CREATE_FINGERPRINT,
    candidateFingerprint: CREATE_FINGERPRINT, actionTaken: "create_issue", intendedAction: "create_issue",
    result: { issueNumber: 101, issueId: "I_101", commentId: null },
    operatorFinalClassification: [{ fieldName: "Priority", value: "P2" }],
    ...overrides,
  };
}

const DURABLE_COUNTEREXAMPLES = [
  { name: "C1 complete without candidate membership", event: "complete", approved: true, absent: true,
    kind: "complete", executed: true, disposition: "executed" },
  { name: "C2 unresolved without candidate membership", event: "create_unresolved", approved: true, absent: true,
    kind: "unresolved_unknown", executed: false, disposition: "refused" },
  { name: "C3 conflicting legacy fingerprints without approval", event: "legacy", approved: false,
    kind: "legacy_unverified", executed: false, disposition: "refused" },
  { name: "C4 unresolved after approval reset", event: "create_unresolved", approved: false,
    kind: "unresolved_unknown", executed: false, disposition: "refused" },
  { name: "C5 complete rebuilt as null-action replay", event: "complete", approved: false, replay: true,
    kind: "complete", executed: true, disposition: "executed" },
  { name: "C6 malformed transport identity retains landed effect", event: "create_unresolved", approved: true,
    missingNumber: true, kind: "unresolved_partial", executed: false, disposition: "refused" },
] as const;

const DURABLE_APPLY_COUNTEREXAMPLES = [
  ...DURABLE_COUNTEREXAMPLES,
  { name: "C7 never attempted without candidate membership", event: null, approved: true, absent: true, unbound: true,
    kind: "never_attempted", executed: false, disposition: "refused" },
  { name: "C8 markerless classification recovery without candidate membership", event: "classification_failed",
    approved: true, absent: true, unbound: true, markerless: true,
    kind: "classification_failed", executed: false, disposition: "refused" },
] as const;

function counterexampleLedger(test: typeof DURABLE_APPLY_COUNTEREXAMPLES[number]) {
  if (test.event === null) return [];
  if ("markerless" in test) return [durableEvent(test.event, {
    payload: { issue: null, evidenceComment: null, closeIssue: null }, issueNumber: 101, issueId: "I_101",
  })];
  if (test.event === "legacy") return [{
    schemaVersion: "github-issue-roadmap-intake-approval-ledger/v1",
    mode: "execute", executed: true, disposition: "executed",
    sourceFingerprint: CREATE_FINGERPRINT, candidateFingerprint: APPEND_FINGERPRINT,
    actionTaken: "append_evidence", intendedAction: "append_evidence",
    result: { issueNumber: 101, issueId: "I_101", commentId: "IC_202" },
  }];
  return [durableEvent(test.event, "missingNumber" in test ? { issueNumber: undefined, issueId: "I_101" } : {})];
}

describe("exclusive repository execution ownership", () => {
  function prepared() {
    const value = fixture();
    value.plan.entries[0].approved = true;
    value.persistPlan();
    const lockPath = join(dirname(value.journalPath), "execution.lock");
    const ownerPath = join(lockPath, "owner.json");
    return { ...value, lockPath, ownerPath };
  }

  function owner(overrides: Record<string, unknown> = {}) {
    return {
      token: "a".repeat(32), pid: process.pid, hostname: hostname(),
      bootEpochMs: Math.round((Date.now() - uptime() * 1000) / 1000) * 1000,
      holderUptimeS: uptime(),
      acquiredAt: "2000-01-01T00:00:00.000Z", mode: "execute", ...overrides,
    };
  }

  function occupy(value: ReturnType<typeof prepared>, holder = owner()) {
    mkdirSync(value.lockPath);
    writeFileSync(value.ownerPath, JSON.stringify(holder));
    return holder;
  }

  function apply(value: ReturnType<typeof prepared>, transport = fakeTransport(), actionQualificationContext?: ActionQualificationContext) {
    return applyIntakeApprovalPlan({ ...value.execution, planPath: value.planPath, execute: true,
      trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, transport, now: NOW, actionQualificationContext });
  }

  function refusal(value: ReturnType<typeof prepared>, holder: ReturnType<typeof owner>) {
    return `Execution journal claim refused: ${value.lockPath} is held by pid ${holder.pid} on ${holder.hostname}, acquiredAt ${holder.acquiredAt}, mode ${holder.mode}. The run must be stopped (or the host restarted) before the claim can be cleared; if pid ${holder.pid} is not an intake run, stop it or reboot.`;
  }

  function replaceToken(value: ReturnType<typeof prepared>) {
    const holder = JSON.parse(readFileSync(value.ownerPath, "utf8"));
    writeFileSync(value.ownerPath, JSON.stringify({ ...holder, token: "b".repeat(32) }));
  }

  it("allows one concurrent execute to create and refuses the loser before reading the journal", async () => {
    const value = prepared();
    const first = fakeTransport();
    let resume!: () => void;
    let dispatched!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    const entered = new Promise<void>((resolve) => { dispatched = resolve; });
    vi.mocked(first.createIssue).mockImplementation(async () => {
      dispatched();
      await paused;
      return { issueNumber: 101, issueId: "I_101" };
    });
    const running = apply(value, first);
    await entered;
    try {
      const holder = JSON.parse(readFileSync(value.ownerPath, "utf8"));
      const before = readFileSync(value.journalPath);
      const journalReads = () => vi.mocked(readFileSync).mock.calls.filter(([path]) => path === value.journalPath).length;
      const reads = journalReads();
      const loser = fakeTransport();
      const error = await apply(value, loser).catch((error: unknown) => error);
      expect(error).toMatchObject({ name: "ExecutionClaimRefusedError", message: refusal(value, holder) });
      expect(error).not.toBeInstanceOf(JournalWriteError);
      expect(journalReads()).toBe(reads);
      for (const method of Object.values(loser)) expect(method).not.toHaveBeenCalled();
      expect(readFileSync(value.journalPath)).toEqual(before);
      expect(readFileSync(value.ownerPath, "utf8")).toBe(JSON.stringify(holder) + "\n");
      const ledger = join(value.root, "legacy.jsonl");
      writeFileSync(ledger, JSON.stringify(legacyExecution()) + "\n");
      await expect(applyIntakeApprovalPlan({ planPath: value.planPath, importLedgerPaths: [ledger] }))
        .rejects.toThrow(refusal(value, holder));
    } finally { resume(); }
    const result = await running;
    expect(first.createIssue).toHaveBeenCalledTimes(1);
    expect(readJournal(value.journalPath).records.map((row) => (row as { event?: string }).event))
      .toEqual(["intent", "created", "complete", undefined, undefined]);
    expect(result.ledgerRecords[0].durableState).toBe("complete");
    expect(result.ownership).toEqual({ acquired: true, pid: process.pid, acquiredAt: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain('"token"');
    expect(existsSync(value.lockPath)).toBe(false);
  });

  it("journals B's landed create while A parks its live owner, then restores B and keeps the next run complete", async () => {
    const value = prepared();
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    occupy(value, owner({ pid: 2147483000 }));
    // A has read dead S and paused. Retain that diagnosis across B's reclamation.
    const staleBytes = readFileSync(value.ownerPath, "utf8");
    const kill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === 2147483000 && signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return kill(pid, signal);
    });
    const parkedPath = join(value.lockPath, "owner.stale.paused-A");
    let winnerBytes!: Buffer;
    let refusalA: unknown;
    let resumedA = false;
    const transport = fakeTransport();
    vi.mocked(transport.createIssue).mockImplementation(async () => {
      // B's POST has landed; A resumes its rename before B can journal created.
      winnerBytes = readFileSync(value.ownerPath);
      expect(JSON.parse(winnerBytes.toString("utf8")).token).not.toBe(JSON.parse(staleBytes).token);
      fs.renameSync(value.ownerPath, parkedPath);
      return { issueNumber: 101, issueId: "I_101" };
    });
    vi.mocked(fsyncSync).mockImplementation((fd) => {
      fs.fsyncSync(fd);
      const records = readJournal(value.journalPath).records as { event?: string; issueNumber?: number }[];
      if (records.at(-1)?.event !== "created" || resumedA) return;
      resumedA = true;
      expect(records).toEqual([expect.objectContaining({ event: "intent" }),
        expect.objectContaining({ event: "created", issueNumber: 101, issueId: "I_101" })]);
      expect(existsSync(value.ownerPath)).toBe(false);
      expect(readFileSync(parkedPath)).toEqual(winnerBytes);
      // Resume A's synchronous reclaimer at verification by replaying its saved
      // diagnosis and already-performed park through the fs stubs. Verification,
      // token-mismatch restoration, and refusal still run in the real reclaimer.
      vi.mocked(readFileSync).mockImplementationOnce((() => staleBytes) as unknown as typeof readFileSync);
      vi.mocked(renameSync).mockImplementationOnce((from, to) => {
        expect(from).toBe(value.ownerPath);
        fs.renameSync(parkedPath, to);
      });
      try { acquireExecutionClaim(value.journalPath, { mode: "execute" }); }
      catch (error) { refusalA = error; }
      expect(refusalA).toMatchObject({ name: "ExecutionClaimRefusedError" });
      expect(readFileSync(value.ownerPath)).toEqual(winnerBytes);
      expect(fs.readdirSync(value.lockPath)).toEqual(["owner.json"]);
    });
    const result = await apply(value, transport);
    expect(resumedA).toBe(true);
    expect(refusalA).toMatchObject({ name: "ExecutionClaimRefusedError" });
    expect(transport.createIssue).toHaveBeenCalledOnce();
    expect(result.ledgerRecords[0].durableState).toBe("complete");
    expect(result.ownership?.releaseError).toBeUndefined();
    expect(readJournal(value.journalPath).records.map((row) => (row as { event?: string }).event))
      .toEqual(["intent", "created", "complete", undefined, undefined]);
    expect(existsSync(value.lockPath)).toBe(false);
    vi.mocked(fsyncSync).mockReset();
    const nextTransport = fakeTransport();
    const next = await apply(value, nextTransport);
    expect(next.ledgerRecords[0]).toMatchObject({ durableState: "complete", disposition: "executed" });
    expect(nextTransport.createIssue).not.toHaveBeenCalled();
    expect(nextTransport.applyClassification).not.toHaveBeenCalled();
  });

  it.each(["reboot", "dead pid"])("clears only a proven %s and holds the replacement during preflight", async (reason) => {
    const value = prepared();
    const holder = occupy(value, owner(reason === "reboot"
      ? { holderUptimeS: uptime() + 60000 } : { pid: 2147483000 }));
    const kill = process.kill.bind(process);
    const probe = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === 2147483000 && signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return kill(pid, signal);
    });
    const transport = fakeTransport();
    vi.mocked(transport.preflightClassifications).mockImplementation(async () => {
      const replacement = JSON.parse(readFileSync(value.ownerPath, "utf8"));
      expect(replacement).toMatchObject({ pid: process.pid, hostname: hostname(), mode: "execute", planPath: value.planPath });
      expect(replacement.token).toMatch(/^[0-9a-f]{32}$/);
      expect(replacement.token).not.toBe(holder.token);
      expect(existsSync(value.journalPath)).toBe(false);
    });
    await apply(value, transport);
    expect(transport.createIssue).toHaveBeenCalledOnce();
    if (reason === "dead pid") expect(probe).toHaveBeenCalledExactlyOnceWith(holder.pid, 0);
    else expect(probe).not.toHaveBeenCalled();
    expect(existsSync(value.lockPath)).toBe(false);
  });

  it.each(["alive", "other host", "EPERM", "unknown kill error"])("refuses a %s holder regardless of its age", async (reason) => {
    const value = prepared();
    const holder = occupy(value, owner(reason === "other host" ? { hostname: "other-host", bootEpochMs: 0 } : {}));
    if (reason === "EPERM" || reason === "unknown kill error") {
      vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error(reason), { code: reason === "EPERM" ? "EPERM" : "EINVAL" });
      });
    }
    const transport = fakeTransport();
    await expect(apply(value, transport)).rejects.toMatchObject({ name: "ExecutionClaimRefusedError", message: refusal(value, holder) });
    for (const method of Object.values(transport)) expect(method).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(value.ownerPath, "utf8"))).toEqual(holder);
    expect(existsSync(value.journalPath)).toBe(false);
  });

  it.each([undefined, "{broken", "null", "{}"])("preserves an undiagnosable occupied directory (%s)", async (metadata) => {
    const value = prepared();
    mkdirSync(value.lockPath);
    if (metadata !== undefined) writeFileSync(value.ownerPath, metadata);
    await expect(apply(value)).rejects.toMatchObject({ name: "ExecutionClaimRefusedError",
      message: `Execution journal claim refused: ${value.lockPath} is occupied and undiagnosable (owner.json is missing, unreadable, or invalid). Remove this directory by hand only after confirming no intake run is live.` });
    expect(existsSync(value.lockPath)).toBe(true);
    if (metadata !== undefined) expect(readFileSync(value.ownerPath, "utf8")).toBe(metadata);
    else expect(existsSync(value.ownerPath)).toBe(false);
    expect(existsSync(value.journalPath)).toBe(false);
  });

  it.each(["intent", "observation", "recovery"])("revalidates ownership before an %s append", async (site) => {
    const value = prepared();
    const transport = fakeTransport();
    if (site === "recovery") writeFileSync(value.journalPath, JSON.stringify(durableEvent("intent")) + "\n");
    if (site === "observation") {
      value.plan.entries[0].approved = false;
      value.persistPlan();
    }
    const before = existsSync(value.journalPath) ? readFileSync(value.journalPath) : null;
    const runGit = (cwd: string, args: readonly string[]) => { replaceToken(value); return fakeGit(cwd, args); };
    await expect(applyIntakeApprovalPlan({ ...value.execution, runGit, planPath: value.planPath, execute: true,
      trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, transport })).rejects.toMatchObject({ name: "ExecutionOwnershipError" });
    expect(transport.createIssue).not.toHaveBeenCalled();
    expect(transport.applyClassification).not.toHaveBeenCalled();
    if (before !== null) expect(readFileSync(value.journalPath)).toEqual(before);
    else expect(existsSync(value.journalPath)).toBe(false);
    expect(JSON.parse(readFileSync(value.ownerPath, "utf8")).token).toBe("b".repeat(32));
  });

  it("revalidates after the intent fsync before POST and preserves unresolved ownership on the next run", async () => {
    const value = prepared();
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fsyncSync).mockImplementation((fd) => {
      fs.fsyncSync(fd);
      if (readJournal(value.journalPath).records.length === 1) replaceToken(value);
    });
    const transport = fakeTransport();
    await expect(apply(value, transport)).rejects.toMatchObject({ name: "ExecutionOwnershipError" });
    expect(transport.createIssue).not.toHaveBeenCalled();
    expect(readJournal(value.journalPath).records).toEqual([expect.objectContaining({ event: "intent" })]);
    expect(existsSync(value.lockPath)).toBe(true);
    vi.mocked(fsyncSync).mockReset();
    // Make the replacement holder provably unable to resume; clearing keeps the intent.
    writeFileSync(value.ownerPath, JSON.stringify(owner({ token: "b".repeat(32), holderUptimeS: uptime() + 60000 })));
    const next = fakeTransport();
    const result = await apply(value, next);
    expect(next.createIssue).not.toHaveBeenCalled();
    expect(next.applyClassification).not.toHaveBeenCalled();
    expect(result.ledgerRecords[0]).toMatchObject({ durableState: "unresolved_unknown", disposition: "refused" });
    expect(readJournal(value.journalPath).records.map((row) => (row as { event?: string }).event))
      .toEqual(["intent", "create_unresolved", undefined, undefined]);
    expect(existsSync(value.lockPath)).toBe(false);
  });

  it.each(["initial", "recovery"])("revalidates before each classification mutation during %s execution", async (mode) => {
    const value = prepared();
    if (mode === "recovery") writeFileSync(value.journalPath, JSON.stringify(durableEvent("created", {
      issueNumber: 101, issueId: "I_101", classifications: [{ fieldName: "Type", value: "Task" }, { fieldName: "Priority", value: "P2" }],
    })) + "\n");
    const transport = fakeTransport();
    vi.mocked(transport.applyClassification).mockImplementationOnce(async () => {
      replaceToken(value);
      return { identifier: "first-field" };
    });
    await expect(apply(value, transport)).rejects.toMatchObject({ name: "ExecutionOwnershipError" });
    expect(transport.applyClassification).toHaveBeenCalledTimes(1);
    expect(transport.verifyClassifications).not.toHaveBeenCalled();
    expect(readJournal(value.journalPath).records.map((row) => (row as { event?: string }).event))
      .toEqual(mode === "recovery" ? ["created"] : ["intent", "created"]);
  });

  it.each(["initial", "recovery"])("fences the HTTP classification POST after held field definitions during %s execution", async (mode) => {
    const value = prepared();
    if (mode === "recovery") writeFileSync(value.journalPath, JSON.stringify(durableEvent("created", {
      issueNumber: 101, issueId: "I_101",
    })) + "\n");
    let enter!: () => void;
    let resume!: (response: Response) => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const definitions = new Promise<Response>((resolve) => { resume = resolve; });
    const mutations: string[] = [];
    const graphqlReads: string[] = [];
    const concrete = createGitHubIntakeApprovalTransport({ token: "test-token", fetchImpl: async (url, init) => {
      if (init?.method === "GET" && String(url).includes("/issue-fields?")) {
        enter();
        return definitions;
      }
      // GraphQL is POST-shaped but read-only here: the pre-write receipt snapshot. Track it apart
      // from mutations so this fence test still pins writes exactly.
      if (String(url).endsWith("/graphql")) {
        graphqlReads.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ errors: [{ message: "unavailable in this fixture" }] }), { status: 200 });
      }
      mutations.push(`${init?.method} ${url}`);
      return new Response(JSON.stringify({ number: 101, node_id: "I_101" }), { status: 201 });
    } });
    // Keep the actual concrete mutation methods. A no-op preflight leaves the
    // definition read pending inside applyClassification, after withOwnership.
    const transport = { ...concrete, preflightClassifications: vi.fn(async () => {}) };
    const running = apply(value, transport).catch((error: unknown) => error);
    await entered;
    const before = readFileSync(value.journalPath);
    const beforeMutations = mutations.slice();
    replaceToken(value);
    const successorBytes = readFileSync(value.ownerPath);
    resume(new Response(JSON.stringify({ issue_fields: [{
      id: 91, name: "Priority", options: [{ name: "P2" }],
    }] })));
    expect(await running).toMatchObject({ name: "ExecutionOwnershipError" });
    expect(mutations).toEqual(beforeMutations);
    expect(mutations).toHaveLength(mode === "recovery" ? 0 : 2); // Initial create and Type PATCH landed first.
    // The only GraphQL traffic is the pre-write snapshot read; no post-write receipt read-back
    // (which first resolves the viewer) runs for a write the fence refused.
    expect(graphqlReads.every((body) => body.includes("IntakeFieldWriteReceipt"))).toBe(true);
    expect(graphqlReads.some((body) => body.includes("IntakeFilingViewer"))).toBe(false);
    expect(readFileSync(value.journalPath)).toEqual(before);
    expect(readFileSync(value.ownerPath)).toEqual(successorBytes);
  });

  it.each(["evidence append", "close"])("revalidates immediately before the %s mutation", async (site) => {
    const value = prepared();
    const decisionContent = JSON.stringify(addClose(report()));
    writeFileSync(value.decisionPath, decisionContent);
    const plan = buildIntakeApprovalPlan({ decisionPath: value.decisionPath, decisionContent, now: NOW });
    plan.entries[1].approved = true;
    writeFileSync(value.planPath, JSON.stringify(plan));
    writeRunEvidenceFixture(value.planPath, EVIDENCE_CENSUS, true);
    const transport = fakeTransport();
    if (site === "evidence append") {
      const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
      vi.mocked(fsyncSync).mockImplementation((fd) => {
        fs.fsyncSync(fd);
        const records = readJournal(value.journalPath).records as { event?: string }[];
        if (records.at(-1)?.event === "intent") replaceToken(value);
      });
    } else {
      vi.mocked(transport.appendEvidenceComment).mockImplementation(async () => {
        replaceToken(value);
        return { commentId: "IC_202" };
      });
    }
    await expect(apply(value, transport, LEGACY_CLOSE_QUALIFICATION)).rejects.toMatchObject({ name: "ExecutionOwnershipError" });
    expect(transport.createIssue).not.toHaveBeenCalled();
    expect(transport.appendEvidenceComment).toHaveBeenCalledTimes(site === "close" ? 1 : 0);
    expect(transport.closeIssue).not.toHaveBeenCalled();
    expect(readJournal(value.journalPath).records.map((row) => (row as { event?: string }).event)).toEqual([undefined, "intent"]);
  });

  it("releases the claim after a thrown preflight error", async () => {
    const value = prepared();
    const transport = fakeTransport();
    vi.mocked(transport.preflightClassifications).mockRejectedValueOnce(new Error("preflight unavailable"));
    await expect(apply(value, transport)).rejects.toThrow("preflight unavailable");
    expect(existsSync(value.lockPath)).toBe(false);
    expect(existsSync(value.journalPath)).toBe(false);
    await apply(value, transport);
    expect(transport.createIssue).toHaveBeenCalledOnce();
    expect(existsSync(value.lockPath)).toBe(false);
  });

  it("refuses release after a final append loses its token and leaves the successor intact", async () => {
    const value = prepared();
    value.plan.entries[0].approved = false;
    value.persistPlan();
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fsyncSync).mockImplementation((fd) => {
      fs.fsyncSync(fd);
      if (readJournal(value.journalPath).records.length === 3) replaceToken(value);
    });
    const result = await apply(value);
    expect(result.ownership?.releaseError).toBe(`Execution journal ownership lost: ${value.lockPath}; owner metadata is missing, unreadable, or belongs to someone else. No write or release is permitted.`);
    expect(readJournal(value.journalPath).records).toHaveLength(3);
    expect(JSON.parse(readFileSync(value.ownerPath, "utf8")).token).toBe("b".repeat(32));
  });

  it.each(["execute", "import"])("prints a successful %s result with releaseError and exits non-zero when release throws", async (mode) => {
    const value = prepared();
    let releaseMessage!: string;
    vi.mocked(renameSync).mockImplementationOnce((from, to) => {
      const token = JSON.parse(readFileSync(value.ownerPath, "utf8")).token;
      const message = `EPERM: operation not permitted, rename '${from}' -> '${to}'`;
      releaseMessage = message.replaceAll(token, "[redacted]");
      throw new Error(message);
    });
    const log = vi.fn();
    const previousExitCode = process.exitCode;
    const ledger = join(value.root, "legacy.jsonl");
    writeFileSync(ledger, JSON.stringify(legacyExecution()) + "\n");
    const argv = mode === "execute"
      ? [`--plan=${value.planPath}`, "--execute", `--run-evidence=${value.runEvidencePath}`, `--origin-main-sha=${VERIFIED_ORIGIN_MAIN_SHA}`,
        `--candidate=${value.candidatePath}`, `--existence=${value.existencePath}`]
      : [`--plan=${value.planPath}`, `--import-ledger=${ledger}`];
    try {
      const result = await runIntakeApplyCli({ argv, repoRoot: value.root, runGit: fakeGit,
        dispositionHistory: emptyDispositionHistory,
        operatorToken: mode === "execute" ? "test-token" : undefined, transport: fakeTransport(), log });
      expect(result.ownership?.releaseError).toBe(releaseMessage);
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.parse(log.mock.calls[0][0])).toEqual(result);
      expect(process.exitCode).toBe(1);
      if (mode === "execute") expect(result.ledgerRecords[0].durableState).toBe("complete");
      else expect(result.importedLedgers?.imported).toBe(1);
      expect(readJournal(value.journalPath).records.length).toBeGreaterThan(0);
      expect(log.mock.calls[0][0]).not.toContain(JSON.parse(readFileSync(value.ownerPath, "utf8")).token);
    } finally { process.exitCode = previousExitCode; }
  });

  it.each([false, true])("preserves the original run error when release throws (existing cause=%s)", async (hasCause) => {
    const value = prepared();
    const originalCause = new Error("preflight root cause");
    const original = new Error("preflight unavailable", hasCause ? { cause: originalCause } : undefined);
    const cleanupError = new Error("release rename denied");
    const transport = fakeTransport();
    vi.mocked(transport.preflightClassifications).mockRejectedValueOnce(original);
    vi.mocked(renameSync).mockImplementationOnce(() => { throw cleanupError; });
    const error = await apply(value, transport).catch((error: unknown) => error);
    expect(error).toBe(original);
    expect(original.message).toBe("preflight unavailable");
    expect(original.cause).toBe(hasCause ? originalCause : cleanupError);
    if (hasCause) expect(error).toMatchObject({ suppressed: [cleanupError] });
    expect(existsSync(value.ownerPath)).toBe(true);
    expect(existsSync(value.journalPath)).toBe(false);
  });

  it("records a transport's plain-string failure and the release error without losing either", async () => {
    const value = prepared();
    const original = "transport unavailable as a plain string";
    const cleanupError = new Error("release rename denied");
    const transport = fakeTransport();
    vi.mocked(transport.createIssue).mockRejectedValueOnce(original);
    vi.mocked(renameSync).mockImplementationOnce(() => { throw cleanupError; });
    const result = await apply(value, transport);
    expect(result.failures).toEqual([{ sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue",
      stage: "dispatch", issueNumber: null, error: original }]);
    expect(result.ownership?.releaseError).toBe(cleanupError.message);
    expect(transport.createIssue).toHaveBeenCalledOnce();
    expect(readJournal(value.journalPath).records.map((row) => (row as { event?: string }).event))
      .toEqual(["intent", "create_unresolved", undefined, undefined]);
    expect(existsSync(value.ownerPath)).toBe(true);
  });

  it("holds an import claim before journal reads, excludes execute, and exposes ownership without a token in CLI JSON", async () => {
    const value = prepared();
    const ledger = join(value.root, "legacy.jsonl");
    writeFileSync(ledger, JSON.stringify(legacyExecution()) + "\n");
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let contender: Promise<unknown> | undefined;
    let holder: ReturnType<typeof owner> | undefined;
    vi.mocked(fsyncSync).mockImplementation((fd) => {
      fs.fsyncSync(fd);
      if (contender !== undefined) return;
      expect(vi.mocked(readFileSync).mock.calls.some(([path]) => path === value.journalPath)).toBe(false);
      holder = JSON.parse(readFileSync(value.ownerPath, "utf8"));
      expect(holder).toMatchObject({ pid: process.pid, mode: "import" });
      contender = apply(value).catch((error: unknown) => error);
    });
    const log = vi.fn();
    const result = await runIntakeApplyCli({ argv: [`--plan=${value.planPath}`, `--import-ledger=${ledger}`], log });
    expect(await contender).toMatchObject({ name: "ExecutionClaimRefusedError", message: refusal(value, holder!) });
    expect(result.importedLedgers?.imported).toBe(1);
    expect(JSON.parse(log.mock.calls[0][0]).ownership).toEqual({ acquired: true, pid: process.pid, acquiredAt: holder!.acquiredAt });
    expect(log.mock.calls[0][0]).not.toContain(holder!.token);
    expect(existsSync(value.lockPath)).toBe(false);
  });

  it("revalidates import appends and preserves the replacement claim", async () => {
    const value = prepared();
    const ledger = join(value.root, "legacy.jsonl");
    writeFileSync(ledger, JSON.stringify(legacyExecution()) + "\n");
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(readFileSync).mockImplementation(((path: Parameters<typeof readFileSync>[0], options: never) => {
      if (path === ledger) replaceToken(value);
      return fs.readFileSync(path, options);
    }) as typeof readFileSync);
    await expect(applyIntakeApprovalPlan({ planPath: value.planPath, importLedgerPaths: [ledger] }))
      .rejects.toMatchObject({ name: "ExecutionOwnershipError" });
    expect(existsSync(value.journalPath)).toBe(false);
    expect(JSON.parse(readFileSync(value.ownerPath, "utf8")).token).toBe("b".repeat(32));
  });

  it("releases an import claim on validation error", async () => {
    const value = prepared();
    const ledger = join(value.root, "invalid.jsonl");
    writeFileSync(ledger, "{broken");
    await expect(applyIntakeApprovalPlan({ planPath: value.planPath, importLedgerPaths: [ledger] }))
      .rejects.toMatchObject({ name: "ImportRefusedError" });
    expect(existsSync(value.lockPath)).toBe(false);
    expect(existsSync(value.journalPath)).toBe(false);
  });

  it("never creates or acquires a claim for dry-run", async () => {
    const value = prepared();
    const result = await applyIntakeApprovalPlan({ planPath: value.planPath });
    expect(result.ownership).toBeUndefined();
    expect(existsSync(value.lockPath)).toBe(false);
    const holder = occupy(value);
    await expect(applyIntakeApprovalPlan({ planPath: value.planPath })).resolves.toMatchObject({ mode: "dry-run" });
    expect(JSON.parse(readFileSync(value.ownerPath, "utf8"))).toEqual(holder);
    expect(fsyncSync).not.toHaveBeenCalled();
  });
});

describe("shared repository execution journal", () => {
  it.each(["example-org/example-repo", "example-org/example-repo"])
    ("creates exactly once across two plans with distinct paths and decision hashes (repository=%s)", async (repository) => {
    const first = fixture();
    const second = fixture();
    first.plan.entries[0].approved = true;
    first.persistPlan();
    const source = report();
    if (repository === "example-org/example-repo") source.generatedAt = new Date(NOW.getTime() + 1000).toISOString();
    source.repository.organization = repository.split("/")[0];
    for (const candidate of source.candidates) if (candidate.draft !== null) candidate.draft.repository = repository;
    const decisionContent = JSON.stringify(source);
    writeFileSync(second.decisionPath, decisionContent, "utf8");
    const plan = buildIntakeApprovalPlan({ decisionPath: second.decisionPath, decisionContent, now: NOW });
    plan.entries[0].approved = true;
    writeFileSync(second.planPath, JSON.stringify(plan), "utf8");
    writeRunEvidenceFixture(second.planPath, EVIDENCE_CENSUS, true);
    expect(first.planPath).not.toBe(second.planPath);
    expect(first.plan.decision.contentSha256).not.toBe(plan.decision.contentSha256);
    expect(first.journalPath).toBe(second.journalPath);
    const transport = fakeTransport();
    const apply = (value: ReturnType<typeof fixture>) => applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true,
      trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, transport, now: NOW,
    });
    const created = await apply(first);
    const preview = await applyIntakeApprovalPlan({ planPath: second.planPath, now: NOW });
    expect(preview.ledgerRecords[0]).toMatchObject({ durableState: "complete", executed: true,
      result: created.ledgerRecords[0].result });
    expect(preview.ledgerRecords[0].historicalOperations?.[0].repository).toBe("example-org/example-repo");
    const replayed = await apply(second);
    expect(transport.createIssue).toHaveBeenCalledTimes(1);
    expect(replayed.journalPath).toBe(created.journalPath);
    expect(replayed.ledgerRecords[0]).toMatchObject({ durableState: "complete", executed: true,
      result: { issueNumber: 101, issueId: "I_101" } });
    expect(readJournal(created.journalPath).records.filter((row) => (row as { event?: string }).event === "intent")).toHaveLength(1);
    expect(existsSync(`${first.planPath}.ledger.jsonl`)).toBe(false);
    expect(existsSync(`${second.planPath}.ledger.jsonl`)).toBe(false);
    // The former per-plan selection cannot express a successful execute invocation.
    await expect(applyIntakeApprovalPlan({ ...second.execution, planPath: second.planPath, execute: true,
      ledgerPath: `${second.planPath}.ledger.jsonl`, trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, transport }))
      .rejects.toThrow("--ledger is not supported in execute mode.");
    expect(transport.createIssue).toHaveBeenCalledTimes(1);
  });

  it("surfaces the journal tail in dry-run results and CLI JSON before execute refuses an indeterminate create budget", async () => {
    const value = fixture();
    value.plan.entries[0].approved = true;
    value.persistPlan();
    expect((await applyIntakeApprovalPlan({ planPath: value.planPath })).journalTail).toEqual({ present: false });
    const bytes = `{"repository":"example-org/example-repo","sourceFingerprint":"${APPEND_FINGERPRINT}","event":`;
    writeFileSync(value.journalPath, bytes, "utf8");
    const log = vi.fn();
    const result = await runIntakeApplyCli({ argv: [`--plan=${value.planPath}`], log });
    expect(result.journalTail).toEqual({ present: true });
    expect(JSON.parse(log.mock.calls[0][0]).journalTail).toEqual({ present: true });
    expect(result.ledgerRecords[1].durableState).toBe("malformed");
    const cli = executeCli(value);
    const executed = await cli.result;
    expect(executed.ledgerRecords[0].refusalReason).toContain("repository_create_budget_unavailable");
    expect(cli.openTransport).not.toHaveBeenCalled();
    expect(cli.transport.createIssue).not.toHaveBeenCalled();
    expect(cli.transport.applyClassification).not.toHaveBeenCalled();
    expect(readFileSync(value.journalPath, "utf8")).toBe(bytes);
    expect(fsyncSync).toHaveBeenCalledTimes(1); // Claim metadata only; no journal append.
  });

  it.each(["valid JSON", "partial JSON", "unattributable JSON"])
    ("an unterminated tail affects only its attributable identity: %s", async (kind) => {
      const value = fixture();
      const prior = durableEvent("complete");
      const segment = kind === "valid JSON" ? JSON.stringify(durableEvent("complete", { sourceFingerprint: APPEND_FINGERPRINT }))
        : kind === "partial JSON" ? `{"repository":"example-org/example-repo","sourceFingerprint":"${APPEND_FINGERPRINT}","event":`
        : '{"event":';
      const content = `${JSON.stringify(prior)}\n${segment}`;
      writeFileSync(value.journalPath, content, "utf8");
      const cli = executeCli(value);
      const result = await cli.result;
      expect(result.ledgerRecords[0]).toMatchObject({ durableState: "complete", executed: true, result: { issueNumber: 101 } });
      expect(result.ledgerRecords[1].durableState).toBe(kind === "unattributable JSON" ? "never_attempted" : "malformed");
      expect(result.ledgerRecords[2].durableState).toBe("never_attempted");
      expect(cli.openTransport).not.toHaveBeenCalled();
      expect(readFileSync(value.journalPath, "utf8")).toBe(content);
    });

  it("aborts on intent fsync failure before dispatch and never retries the recorded intent", async () => {
    const value = fixture();
    value.plan.entries[0].approved = true;
    value.persistPlan();
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(fsyncSync).mockImplementationOnce(fs.fsyncSync) // Claim metadata.
      .mockImplementationOnce(() => { throw new Error("fsync unavailable"); });
    const cli = executeCli(value);
    await expect(cli.result).rejects.toThrow(JournalWriteError);
    // Preserve the established read-only preflight-before-intent ordering.
    expect(cli.transport.preflightClassifications).toHaveBeenCalledTimes(1);
    expect(cli.transport.createIssue).not.toHaveBeenCalled();
    expect(cli.transport.appendEvidenceComment).not.toHaveBeenCalled();
    expect(cli.transport.closeIssue).not.toHaveBeenCalled();
    expect(cli.transport.applyClassification).not.toHaveBeenCalled();
    expect(cli.transport.verifyClassifications).not.toHaveBeenCalled();
    expect(readJournal(value.journalPath).records).toEqual([expect.objectContaining({ event: "intent" })]);
    const retry = executeCli(value);
    expect((await retry.result).ledgerRecords[0].durableState).toBe("unresolved_unknown");
    expect(retry.openTransport).not.toHaveBeenCalled();
  });

  it.each([2, 3])("does not reclassify a journal fsync failure at transition %s as a remote failure", async (transition) => {
    const value = fixture();
    value.plan.entries[0].approved = true;
    value.persistPlan();
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let calls = 0;
    vi.mocked(fsyncSync).mockImplementation((fd) => {
      if (++calls === transition + 1) throw new Error("disk failed"); // Exclude claim metadata fsync.
      fs.fsyncSync(fd);
    });
    const failed = executeCli(value);
    await expect(failed.result).rejects.toThrow(JournalWriteError);
    expect(failed.transport.createIssue).toHaveBeenCalledTimes(1);
    expect(failed.transport.applyClassification).toHaveBeenCalledTimes(transition === 2 ? 0 : 3);
    expect(readJournal(value.journalPath).records.map((row) => (row as { event: string }).event))
      .toEqual(["intent", "created", "complete"].slice(0, transition));
    const recovery = executeCli(value);
    const result = await recovery.result;
    expect(recovery.transport.createIssue).not.toHaveBeenCalled();
    expect(recovery.transport.applyClassification).toHaveBeenCalledTimes(transition === 2 ? 3 : 0);
    expect(recovery.transport.verifyClassifications).toHaveBeenCalledTimes(transition === 2 ? 1 : 0);
    expect(result.ledgerRecords[0]).toMatchObject({ durableState: "complete", result: { issueNumber: 101, issueId: "I_101" } });
    expect(readJournal(value.journalPath).records.some((row) => (row as { event?: string }).event === "classification_failed")).toBe(false);
  });

  it.each([undefined, "malformed", VERIFIED_ORIGIN_MAIN_SHA])
    ("pins the execute ledger flag refusal before SHA/token checks (sha=%s)", async (sha) => {
    const value = fixture();
    const ledger = join(value.root, "legacy.jsonl");
    const transport = fakeTransport();
    const runGit = vi.fn(fakeGit);
    const openTransport = vi.fn(() => transport);
    const refusal = `--ledger is not supported in execute mode. Journal: ${value.journalPath}. Import with: npx tsx scripts/github-issue-roadmap-intake-apply.ts --plan="${value.planPath}" --import-ledger="${ledger}"`;
    await expect(runIntakeApplyCli({ argv: [`--plan=${value.planPath}`, "--execute", `--ledger=${ledger}`,
      ...(sha === undefined ? [] : [`--origin-main-sha=${sha}`])], runGit, openTransport }))
      .rejects.toThrow(new Error(refusal));
    await expect(applyIntakeApprovalPlan({ planPath: value.planPath, execute: true, ledgerPath: ledger,
      trustedCurrentOriginMainSha: sha, runGit, openTransport })).rejects.toThrow(new Error(refusal));
    expect(runGit).not.toHaveBeenCalled();
    expect(openTransport).not.toHaveBeenCalled();
    for (const method of Object.values(transport)) expect(method).not.toHaveBeenCalled();
    expect(existsSync(value.journalPath)).toBe(false);
    expect(fsyncSync).not.toHaveBeenCalled();
  });

  it("keeps dry-run ledger input read-only", async () => {
    const value = fixture();
    const ledger = join(value.root, "legacy.jsonl");
    const bytes = JSON.stringify(legacyExecution()) + "\n";
    writeFileSync(ledger, bytes, "utf8");
    const result = await runIntakeApplyCli({ argv: [`--plan=${value.planPath}`, `--ledger=${ledger}`], log: () => undefined });
    expect(result.journalPath).toBe(value.journalPath);
    expect(result.ledgerRecords[0].durableState).toBe("legacy_unverified");
    // The override previews legacy decisions; executionSummary describes the repository journal as left.
    expect(result.executionSummary).toMatchObject({ operationsTotal: 0, operations: [] });
    expect(readFileSync(ledger, "utf8")).toBe(bytes);
    expect(existsSync(value.journalPath)).toBe(false);
  });

  it("imports repeatable ledger arguments without credentials or transport", async () => {
    const value = fixture();
    const ledger = join(value.root, "legacy.jsonl");
    writeFileSync(ledger, JSON.stringify(legacyExecution({ repository: undefined })) + "\n", "utf8");
    value.plan.entries[0].approved = true;
    value.persistPlan();
    const openTransport = vi.fn(() => fakeTransport());
    const log = vi.fn();
    const result = await runIntakeApplyCli({ argv: [`--plan=${value.planPath}`, `--import-ledger=${ledger}`, `--import-ledger=${ledger}`], openTransport, log });
    expect(result.mode).toBe("dry-run");
    expect(result.importedLedgers).toEqual({ imported: 1, skipped: 1, rejected: 0, malformed: 0, rejectedLines: [], malformedLines: [] });
    expect(result.executionSummary).toMatchObject({ reconciliationsRefused: 0, reconciliationsRefusedReasons: {} });
    expect(result.executionSummary).toMatchObject({ operationsTotal: 1, unverified: 1,
      countsByState: { legacy_unverified: 1 } });
    expect(JSON.parse(log.mock.calls[0][0])).toEqual(result);
    expect(openTransport).not.toHaveBeenCalled();
    expect(importLegacyLedgers(value.journalPath, [ledger])).toEqual({ imported: 0, skipped: 1, rejected: 0, malformed: 0, rejectedLines: [], malformedLines: [] });
    const cli = executeCli(value);
    expect((await cli.result).ledgerRecords[0]).toMatchObject({ durableState: "legacy_unverified", executed: false,
      result: { issueNumber: 101, issueId: "I_101" }, historicalOperations: [{ history: [{ value: {
        kind: "legacy_import", importedFrom: ledger, row: expect.objectContaining({ executed: true }),
      } }] }] });
    expect(cli.transport.createIssue).not.toHaveBeenCalled();
    expect(cli.openTransport).not.toHaveBeenCalled();
  });

  it.each(["CLI", "API"])("refuses --execute with --import-ledger before any side effects (%s)", async (entryPoint) => {
    const value = fixture();
    const ledger = join(value.root, "legacy.jsonl");
    const bytes = JSON.stringify(legacyExecution()) + "\n";
    writeFileSync(ledger, bytes, "utf8");
    const runGit = vi.fn(fakeGit);
    const openTransport = vi.fn(() => fakeTransport());
    const result = entryPoint === "CLI"
      ? runIntakeApplyCli({ argv: [`--plan=${value.planPath}`, "--execute", `--import-ledger=${ledger}`], runGit, openTransport })
      : applyIntakeApprovalPlan({ planPath: value.planPath, execute: true, importLedgerPaths: [ledger], runGit, openTransport });
    await expect(result).rejects.toThrow(new Error("--execute cannot be combined with --import-ledger."));
    expect(runGit).not.toHaveBeenCalled();
    expect(openTransport).not.toHaveBeenCalled();
    expect(existsSync(value.journalPath)).toBe(false);
    expect(existsSync(join(dirname(value.journalPath), "execution.lock"))).toBe(false);
    expect(readFileSync(ledger, "utf8")).toBe(bytes);
    expect(fsyncSync).not.toHaveBeenCalled();
  });

  it("refuses a plan spanning repositories before probing, transport or import", async () => {
    const value = fixture();
    const second = report();
    second.repository = { organization: "Other", name: "repository" };
    second.candidates = [second.candidates[2]];
    second.candidates[0].sourceFingerprint = "d".repeat(64);
    const decisionPath = join(value.root, "other.json");
    writeFileSync(decisionPath, JSON.stringify(second), "utf8");
    runIntakeApproveCli({ argv: [`--decision=${value.decisionPath}`, `--decision=${decisionPath}`, `--out=${value.planPath}`], now: NOW });
    const cli = executeCli(value);
    await expect(cli.result).rejects.toThrow("Approval plan spans repositories; one repository journal is required.");
    expect(cli.runGit).not.toHaveBeenCalled();
    expect(cli.openTransport).not.toHaveBeenCalled();
    expect(existsSync(value.journalPath)).toBe(false);
  });

  it("preserves staged precedence and conflict detection through imported envelopes", () => {
    const identity = { repository: "example-org/example-repo", sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue" as const };
    const wrap = (row: unknown) => ({ kind: "legacy_import", importedFrom: join(journalRoot, "legacy.jsonl"), importedAt: NOW.toISOString(), row });
    const legacy = wrap(legacyExecution());
    const intent = wrap(durableEvent("intent"));
    const complete = wrap(durableEvent("complete"));
    const state = durableSeam.resolveDurableState(durableSeam.indexHistory([legacy, intent, complete]), identity);
    expect(state.kind).toBe("complete");
    expect(state.operations[0].history.map((row) => row.value)).toEqual([intent, complete]);
    const conflict = wrap(durableEvent("complete", { payload: {
      ...durableEvent("complete").payload, issue: { title: "Different", body: "Changed" },
    } }));
    expect(durableSeam.resolveDurableState(durableSeam.indexHistory([legacy, intent, conflict]), identity).kind).toBe("conflict");
    expect(durableSeam.resolveDurableState(durableSeam.indexHistory([wrap({ malformedJson: "{broken" })]), identity).kind).toBe("malformed");
  });
});

describe("durable-state seam counterexamples", () => {
  it.each(DURABLE_COUNTEREXAMPLES)("$name: function contract", (test) => {
    const source = buildIntakeApprovalPlan({ decisionPath: "decision.json", decisionContent: JSON.stringify(report()), now: NOW }).entries[0];
    const entry = { ...source, approved: test.approved,
      ...("replay" in test ? { presentation: "replay_no_op" as const, intendedAction: null, intendedActions: [] } : {}) };
    const rows = counterexampleLedger(test);
    const index = durableSeam.indexHistory(rows);
    const state = durableSeam.resolveDurableState(index, {
      repository: "example-org/example-repo", sourceFingerprint: CREATE_FINGERPRINT,
      action: entry.intendedAction === "append_evidence_overlap" ? "append_evidence" : entry.intendedAction,
    });
    expect(state.kind).toBe(test.kind);
    const projected = durableSeam.projectResult(state, { entry, source, now: NOW, mode: "execute" });
    expect(projected).toMatchObject({ executed: test.executed, disposition: test.disposition });
    expect(projected.result.issueId).toBe(test.executed || "missingNumber" in test || test.event === "legacy" ? "I_101" : null);
    if (test.executed) expect(projected).toMatchObject({ actionTaken: "create_issue", result: { issueNumber: 101 } });
    expect(JSON.parse(JSON.stringify(projected))).toEqual(projected);
  });

  it.each(DURABLE_APPLY_COUNTEREXAMPLES)("$name: ledger, result and CLI", async (test) => {
    const value = fixture();
    const sourceReport = report();
    if ("absent" in test) {
      const envelope = parseOutcomeEnvelope({ ...ENVELOPE, candidates: ENVELOPE.candidates.filter((entry) => entry.sourceFingerprint !== CREATE_FINGERPRINT) });
      const existence = probeExistenceAtSha({ dispositionHistory: emptyDispositionHistory, envelope, originMainSha: VERIFIED_ORIGIN_MAIN_SHA,
        repoRoot: value.root, runGit: fakeGit, budget: Number.MAX_SAFE_INTEGER, generatedAt: NOW.toISOString() });
      writeFileSync(value.candidatePath, JSON.stringify(envelope), "utf8");
      writeFileSync(value.existencePath, JSON.stringify(existence), "utf8");
      sourceReport.decision.candidateSha256 = canonicalJsonSha256(envelope);
      const snapshot = reboundSnapshot(EVIDENCE_CENSUS, envelope);
      sourceReport.decision.snapshotContentSha256 = snapshot.contentSha256;
      sourceReport.decision.assessmentSha256 = canonicalJsonSha256(evidenceAssessment(envelope, snapshot));
      sourceReport.decision.existenceRecordContentSha256 = existence.contentSha256;
    }
    if ("replay" in test) sourceReport.candidates[0] = {
      sourceFingerprint: CREATE_FINGERPRINT, presentation: "replay_no_op", matchResult: "replay",
      draft: null, hold: null, intendedButDenied: [],
    } as never;
    const decisionContent = JSON.stringify(sourceReport);
    writeFileSync(value.decisionPath, decisionContent, "utf8");
    const plan = buildIntakeApprovalPlan({ decisionPath: value.decisionPath, decisionContent, now: NOW });
    plan.entries[0].approved = test.approved;
    writeFileSync(value.planPath, JSON.stringify(plan), "utf8");
    writeRunEvidenceFixture(value.planPath, EVIDENCE_CENSUS, true);
    const rows = counterexampleLedger(test).map((row) => ({ ...row, decisionContentSha256: plan.decision.contentSha256 }));
    if ("unbound" in test) {
      expect(durableSeam.resolveDurableState(durableSeam.indexHistory(rows), {
        repository: "example-org/example-repo", sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue",
      }).kind).toBe(test.kind);
      if (test.event === null) expect(rows).toEqual([]);
    }
    if ("missingNumber" in test) {
      const malformed = fakeTransport();
      vi.mocked(malformed.createIssue).mockResolvedValue({ issueId: "I_101" } as never);
      await expect(applyIntakeApprovalPlan({ ...value.execution, planPath: value.planPath,
        execute: true, trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, transport: malformed, now: NOW }))
        .resolves.toMatchObject({ failures: [{ sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue",
          stage: "dispatch", issueNumber: null, error: expect.stringMatching(/issue number/) }] });
      const recorded = readFileSync(value.journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(recorded.map((row) => row.event)).toEqual(["intent", "create_unresolved", undefined, undefined]);
      expect(recorded[1]).toMatchObject({ issueNumber: null, issueId: "I_101" });
    } else writeFileSync(value.journalPath, rows.length === 0 ? "" : rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    const before = readFileSync(value.journalPath, "utf8");
    const transport = fakeTransport();
    const log = vi.fn();
    const result = await runIntakeApplyCli({ argv: [`--plan=${value.planPath}`,
      "--execute", `--run-evidence=${value.runEvidencePath}`, `--origin-main-sha=${VERIFIED_ORIGIN_MAIN_SHA}`, `--candidate=${value.candidatePath}`, `--existence=${value.existencePath}`],
      repoRoot: value.root, runGit: fakeGit, dispositionHistory: emptyDispositionHistory, operatorToken: "test-token", transport, log });
    expect(transport.createIssue).not.toHaveBeenCalled();
    expect(transport.appendEvidenceComment).not.toHaveBeenCalled();
    expect(transport.verifyClassifications).not.toHaveBeenCalled();
    expect(transport.preflightClassifications).not.toHaveBeenCalled();
    expect(result.ledgerRecords[0]).toMatchObject({ executed: test.executed, disposition: test.disposition });
    expect(result.ledgerRecords[0].result.issueId).toBe(test.executed || "missingNumber" in test || "markerless" in test || test.event === "legacy" ? "I_101" : null);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual(result);
    expect(readFileSync(value.journalPath, "utf8").startsWith(before)).toBe(true);
    expect(readFileSync(value.journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))
      .filter((row) => row.event === "intent")).toHaveLength("missingNumber" in test ? 1 : 0);
    if ("unbound" in test) {
      for (const method of Object.values(transport)) expect(method).not.toHaveBeenCalled();
      expect(result.ledgerRecords[0]).toMatchObject({
        sourceFingerprint: CREATE_FINGERPRINT, executed: false, disposition: "refused",
        actionTaken: null, actionsTaken: [],
        refusalReason: "unbound_outcome_identity: write has no bound outcome identity.",
        result: "markerless" in test ? { issueNumber: 101, issueId: "I_101", commentId: null }
          : { issueNumber: null, issueId: null, commentId: null },
      });
      const after = readFileSync(value.journalPath, "utf8");
      expect(after.length).toBeGreaterThan(before.length);
      expect(after.trim().split("\n").map((line) => JSON.parse(line))
        .filter((row) => row.event === "withdrawn_dispositioned")).toHaveLength(0);
    }
  });
});

describe("durable history recognition and projection", () => {
  const identity = { repository: "example-org/example-repo", sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue" as const };
  const context = () => {
    const source = buildIntakeApprovalPlan({ decisionPath: "decision.json", decisionContent: JSON.stringify(report()), now: NOW }).entries[0];
    return { entry: source, source, now: NOW, mode: "execute" as const };
  };

  it.each([
    { name: "existing staged completion", rows: () => [durableEvent("complete")], kind: "complete" },
    { name: "mixed-case staged transitions", rows: () => [durableEvent("intent"), durableEvent("complete", { repository: "example-org/example-repo" })], kind: "complete" },
    { name: "legacy recognition", rows: () => [legacyExecution()], kind: "legacy_unverified" },
    { name: "malformed ownership", rows: () => [durableEvent("unknown")], kind: "malformed" },
    { name: "staged payload conflict", rows: () => [durableEvent("intent"), durableEvent("complete", {
      repository: "example-org/example-repo", payload: { ...durableEvent("complete").payload, issue: { title: "Different", body: "Changed" } },
    })], kind: "conflict" },
    { name: "legacy identity conflict", rows: () => [legacyExecution(), legacyExecution({
      repository: "example-org/example-repo", result: { issueNumber: 202, issueId: "I_202", commentId: null },
    })], kind: "conflict" },
    { name: "cross-format identity conflict", rows: () => [durableEvent("complete"), legacyExecution({
      repository: "example-org/example-repo", result: { issueNumber: 202, issueId: "I_202", commentId: null },
    })], kind: "conflict" },
  ])("folds existing repository casing for $name", ({ rows, kind }) => {
    const records = rows();
    const state = durableSeam.resolveDurableState(durableSeam.indexHistory(records), { ...identity, repository: "example-org/example-repo" });
    expect(state.kind).toBe(kind);
    const history = state.kind === "malformed" ? state.problems.flatMap((problem) => problem.history)
      : state.operations.flatMap((operation) => operation.history);
    expect(history.map((row) => row.value)).toEqual(expect.arrayContaining([records.at(-1)]));
  });

  it("folds repository casing when attributing an unterminated tail", () => {
    const bytes = Buffer.from(`{"repository":"example-org/example-repo","sourceFingerprint":"${CREATE_FINGERPRINT}","event":`);
    const index = durableSeam.indexHistory([], { bytes, malformed: true });
    const state = durableSeam.resolveDurableState(index, { ...identity, repository: "example-org/example-repo" });
    expect(state).toMatchObject({ kind: "malformed", problems: [{ repository: "example-org/example-repo", unterminatedTail: true }] });
    expect(durableSeam.resolveDurableState(index, { ...identity, sourceFingerprint: APPEND_FINGERPRINT }).kind).toBe("never_attempted");
  });

  it("prefers a staged completion over a compatible legacy row for the same operation", () => {
    const state = durableSeam.resolveDurableState(
      durableSeam.indexHistory([legacyExecution(), durableEvent("complete")]), identity,
    );
    expect(state.kind).toBe("complete");
    expect(durableSeam.projectResult(state, context())).toMatchObject({
      executed: true, disposition: "executed", actionTaken: "create_issue",
      result: { issueNumber: 101, issueId: "I_101", commentId: null },
    });
  });

  it("keeps a legacy-only operation unverified and refused", () => {
    const state = durableSeam.resolveDurableState(durableSeam.indexHistory([legacyExecution()]), identity);
    expect(state.kind).toBe("legacy_unverified");
    expect(durableSeam.projectResult(state, context())).toMatchObject({
      executed: false, disposition: "refused", durableState: "legacy_unverified",
    });
  });

  it("represents a cross-format identity disagreement as an explicit conflict", () => {
    const state = durableSeam.resolveDurableState(durableSeam.indexHistory([
      legacyExecution({ result: { issueNumber: 202, issueId: "I_202", commentId: null } }),
      durableEvent("complete"),
    ]), identity);
    expect(state).toMatchObject({ kind: "conflict" });
    expect(state.operations.map((operation) => operation.provenance)).toEqual(["staged", "legacy"]);
    expect(state.operations.map((operation) => operation.result.issueNumber)).toEqual([101, 202]);
    expect(durableSeam.projectResult(state, context())).toMatchObject({
      executed: false, disposition: "refused", durableState: "conflict",
      refusalReason: expect.stringContaining("Cross-format issueNumber disagreement: staged 101; legacy 202."),
      historyConflicts: expect.arrayContaining([expect.objectContaining({
        reason: "Cross-format issueNumber disagreement: staged 101; legacy 202.",
        left: expect.objectContaining({ provenance: "staged", result: expect.objectContaining({ issueNumber: 101 }) }),
        right: expect.objectContaining({ provenance: "legacy", result: expect.objectContaining({ issueNumber: 202 }) }),
      })]),
    });
    const actionConflict = durableSeam.resolveDurableState(durableSeam.indexHistory([
      legacyExecution({ actionTaken: "append_evidence", intendedAction: "append_evidence",
        result: { issueNumber: 101, issueId: "I_101", commentId: "IC_202" } }),
      durableEvent("complete"),
    ]), identity);
    expect(durableSeam.projectResult(actionConflict, context())).toMatchObject({
      executed: false, durableState: "conflict",
      refusalReason: expect.stringContaining("Cross-format action disagreement: staged create_issue; legacy append_evidence."),
    });
  });

  it("represents contradictory populated payloads as an explicit conflict", () => {
    const first = durableEvent("intent");
    const second = durableEvent("complete", {
      payload: { ...first.payload, issue: { ...first.payload.issue, title: "Contradictory title" } },
    });
    const state = durableSeam.resolveDurableState(durableSeam.indexHistory([first, second]), identity);
    expect(state).toMatchObject({ kind: "conflict" });
    expect(state.operations[0].history.map((row) => row.value)).toEqual([first, second]);
    expect(durableSeam.projectResult(state, context())).toMatchObject({
      executed: false, disposition: "refused", durableState: "conflict",
      refusalReason: expect.stringContaining("Conflicting populated issue payload."),
      historyConflicts: [{
        reason: "Conflicting populated issue payload.",
        left: { history: [{ value: first }] },
        right: { history: [{ value: second }] },
      }],
    });
  });

  it.each([
    { field: "issue", firstValue: { title: "Title A", body: "Body" }, lastValue: { title: "Title B", body: "Body" } },
    { field: "evidenceComment", firstValue: "Comment A", lastValue: "Comment B" },
  ])("detects contradictory populated $field payloads across a null gap", ({ field, firstValue, lastValue }) => {
    const first = durableEvent("intent");
    first.payload = { ...first.payload, [field]: firstValue };
    const gap = durableEvent("intent", { payload: { ...first.payload, [field]: null } });
    const last = durableEvent("complete", { payload: { ...first.payload, [field]: lastValue } });
    const state = durableSeam.resolveDurableState(durableSeam.indexHistory([first, gap, last]), identity);
    expect(state.kind).toBe("conflict");
    expect(durableSeam.projectResult(state, context())).toMatchObject({
      executed: false, disposition: "refused", durableState: "conflict",
    });
  });

  it("allows identical populated payloads to coexist across a null gap", () => {
    const first = durableEvent("intent", {
      payload: { ...durableEvent("intent").payload, evidenceComment: "Same comment" },
    });
    const gap = durableEvent("intent", { payload: { ...first.payload, issue: null, evidenceComment: null } });
    const last = durableEvent("complete", { payload: { ...first.payload } });
    const index = durableSeam.indexHistory([first, gap, last]);
    const state = durableSeam.resolveDurableState(index, identity);
    expect(index.conflicts).toEqual([]);
    expect(state.kind).toBe("complete");
    expect(durableSeam.projectResult(state, context())).toMatchObject({
      executed: true, disposition: "executed", durableState: "complete",
    });
  });

  it("allows populated issue payloads with different object key order", () => {
    const first = durableEvent("intent", {
      payload: { issue: { title: "Same title", body: "Same body" }, evidenceComment: null, closeIssue: null },
    });
    const last = durableEvent("complete", {
      payload: { issue: { body: "Same body", title: "Same title" }, evidenceComment: null, closeIssue: null },
    });
    const index = durableSeam.indexHistory([first, last]);
    const state = durableSeam.resolveDurableState(index, identity);
    expect(index.conflicts).toEqual([]);
    expect(state.kind).toBe("complete");
    expect(durableSeam.projectResult(state, context())).toMatchObject({
      executed: true, disposition: "executed", durableState: "complete",
    });
  });

  it("serializes a conflict through the CLI as a refusal without dispatch", async () => {
    const value = fixture();
    value.plan.entries[0].approved = true;
    value.persistPlan();
    const rows = [
      legacyExecution({ result: { issueNumber: 202, issueId: "I_202", commentId: null } }),
      durableEvent("complete", { decisionContentSha256: value.plan.decision.contentSha256 }),
    ];
    writeFileSync(value.journalPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    const transport = fakeTransport();
    const log = vi.fn();
    const result = await runIntakeApplyCli({
      argv: [`--plan=${value.planPath}`, "--execute", `--run-evidence=${value.runEvidencePath}`,
        `--origin-main-sha=${VERIFIED_ORIGIN_MAIN_SHA}`, `--candidate=${value.candidatePath}`,
        `--existence=${value.existencePath}`],
      repoRoot: value.root, runGit: fakeGit, dispositionHistory: emptyDispositionHistory, operatorToken: "test-token", transport, log,
    });
    expect(result.ledgerRecords[0]).toMatchObject({
      executed: false, disposition: "refused", durableState: "conflict",
      historyConflicts: expect.arrayContaining([
        expect.objectContaining({
          left: expect.objectContaining({ provenance: "staged" }),
          right: expect.objectContaining({ provenance: "legacy" }),
        }),
      ]),
    });
    expect(transport.createIssue).not.toHaveBeenCalled();
    expect(transport.preflightClassifications).not.toHaveBeenCalled();
    expect(JSON.parse(log.mock.calls[0][0])).toEqual(result);
  });

  it.each([
    { name: "empty authoritative scope", rows: [], kind: "never_attempted" },
    { name: "durable intent", rows: [durableEvent("intent")], kind: "intent_unknown" },
    { name: "primary effect", rows: [durableEvent("created", { issueNumber: 101 })], kind: "primary_unverified" },
    { name: "classification failure", rows: [durableEvent("classification_failed", { issueNumber: 101 })], kind: "classification_failed" },
    { name: "positively verified", rows: [durableEvent("complete")], kind: "complete" },
    { name: "unknown unresolved", rows: [durableEvent("create_unresolved")], kind: "unresolved_unknown" },
    { name: "known comment, no issue identity", rows: [durableEvent("create_unresolved", { commentId: "IC_202" })], kind: "unresolved_partial" },
    { name: "known issue ID, no number", rows: [durableEvent("create_unresolved", { issueId: "I_101" })], kind: "unresolved_partial" },
    { name: "prior identity retained through partial failure", rows: [durableEvent("created", { issueNumber: 101, issueId: "I_101" }), durableEvent("create_unresolved")], kind: "unresolved_partial" },
  ])("resolves $name and projects without current classifications", ({ rows, kind }) => {
    const before = JSON.stringify(rows);
    const index = durableSeam.indexHistory(rows);
    const state = durableSeam.resolveDurableState(index, identity);
    expect(state.kind).toBe(kind);
    const invocation = context();
    invocation.entry.deniedClassification.find((item) => item.fieldName === "Priority")!.value = "P1";
    const projected = durableSeam.projectResult(state, invocation);
    if (kind !== "never_attempted") {
      expect(projected.operatorFinalClassification).toEqual([{ fieldName: "Priority", value: "P2" }]);
      expect(projected.historicalOperations![0].history).toHaveLength(rows.length);
    }
    expect(JSON.stringify(rows)).toBe(before);
    expect(durableSeam.resolveDurableState(index, identity)).toEqual(state);
  });

  it.each([
    { name: "non-object", row: null },
    { name: "array", row: [] },
    { name: "unknown event", row: durableEvent("future_event") },
    { name: "object event", row: durableEvent("intent", { event: { toString: null } }) },
    { name: "missing repository", row: durableEvent("complete", { repository: undefined }) },
    { name: "invalid repository", row: durableEvent("complete", { repository: "" }) },
    { name: "missing fingerprint", row: durableEvent("complete", { sourceFingerprint: undefined }) },
    { name: "null staged action", row: durableEvent("complete", { action: null }) },
    { name: "bad schema", row: durableEvent("complete", { schemaVersion: "v999" }) },
    { name: "bad payload", row: durableEvent("complete", { payload: null }) },
    { name: "bad close payload", row: durableEvent("complete", { payload: { issue: null, evidenceComment: null, closeIssue: {} } }) },
    { name: "bad classifications", row: durableEvent("complete", { classifications: [null] }) },
    { name: "missing emission", row: durableEvent("complete", { emissionContentSha256: undefined }) },
    { name: "created without issue number", row: durableEvent("created", { issueNumber: undefined, issueId: "I_101" }) },
    { name: "append complete without comment identity", row: durableEvent("complete", { action: "append_evidence", commentId: null }) },
    { name: "invalid legacy identity", row: { executed: true, sourceFingerprint: CREATE_FINGERPRINT, result: { issueNumber: "101", issueId: "I_101" } } },
    { name: "unattributable legacy", row: { executed: true, result: { issueNumber: 101 } } },
  ])("represents $name as malformed, never absent or thrown", ({ row }) => {
    const state = durableSeam.resolveDurableState(durableSeam.indexHistory([row]), identity);
    expect(state.kind).toBe("malformed");
    const result = durableSeam.projectResult(state, context());
    expect(result).toMatchObject({ executed: false, disposition: "refused", durableState: "malformed" });
    expect(result.historyProblems![0].history[0].value).toEqual(row);
  });

  it.each([
    { name: "conflicting issue identities", later: durableEvent("complete", { issueNumber: 202 }) },
    { name: "completion regressed to intent", later: durableEvent("intent") },
    { name: "changed stored classification", later: durableEvent("complete", { classifications: [{ fieldName: "Priority", value: "P1" }] }) },
    { name: "changed stored emission", later: durableEvent("complete", { emissionContentSha256: "f".repeat(64) }) },
  ])("retains both records for $name", ({ later }) => {
    const state = durableSeam.resolveDurableState(durableSeam.indexHistory([durableEvent("complete"), later]), identity);
    expect(state.kind).toBe("malformed");
    expect(state.operations[0].history).toHaveLength(2);
    expect(durableSeam.projectResult(state, context()).executed).toBe(false);
  });

  it("keeps staged ownership exact and retains multiple actions for a null-action identity", () => {
    const create = durableEvent("complete");
    const append = durableEvent("create_unresolved", { action: "append_evidence", issueNumber: 42, commentId: "IC_202" });
    const index = durableSeam.indexHistory([create, append]);
    expect(durableSeam.resolveDurableState(index, identity).kind).toBe("complete");
    expect(durableSeam.resolveDurableState(index, { ...identity, repository: "Other/repository" }).kind).toBe("never_attempted");
    expect(durableSeam.resolveDurableState(durableSeam.indexHistory([create]), { ...identity, action: "append_evidence" }).kind).toBe("never_attempted");
    const multiple = durableSeam.resolveDurableState(index, { ...identity, action: null });
    expect(multiple.kind).toBe("multiple_actions");
    const result = durableSeam.projectResult(multiple, context());
    expect(result).toMatchObject({ executed: false, disposition: "refused" });
    expect(result.historicalOperations?.map((operation) => operation.result)).toEqual([
      { issueNumber: 101, issueId: "I_101", commentId: null }, { issueNumber: 42, issueId: null, commentId: "IC_202" },
    ]);
  });

  it("distinguishes conflicting legacy identities from multiple legacy actions", () => {
    const create = { executed: true, sourceFingerprint: CREATE_FINGERPRINT, actionTaken: "create_issue",
      result: { issueNumber: 101, issueId: "I_101" } };
    const conflicting = { ...create, result: { issueNumber: 202, issueId: "I_202" } };
    expect(durableSeam.resolveDurableState(durableSeam.indexHistory([create, conflicting]), identity)).toMatchObject({
      kind: "conflict", conflicts: [{ reason: "Conflicting legacy effect identities.",
        left: { history: [{ rowNumber: 1, value: create }] }, right: { history: [{ rowNumber: 2, value: conflicting }] } }],
    });
    const append = { ...conflicting, actionTaken: "append_evidence" };
    const state = durableSeam.resolveDurableState(durableSeam.indexHistory([create, append]), { ...identity, action: null });
    expect(state.kind).toBe("multiple_actions");
    expect(durableSeam.projectResult(state, context()).historicalOperations).toHaveLength(2);
  });

  it.each([null, "append_evidence", "create_issue"])("recognizes legacy action %s by either fingerprint without a repository", (action) => {
    const row = { executed: true, sourceFingerprint: CREATE_FINGERPRINT, candidateFingerprint: APPEND_FINGERPRINT,
      actionTaken: action, intendedAction: "append_evidence", result: { issueNumber: 101, issueId: "I_101" } };
    const index = durableSeam.indexHistory([row]);
    for (const fingerprint of [CREATE_FINGERPRINT, APPEND_FINGERPRINT]) {
      for (const currentAction of ["create_issue", "append_evidence", null] as const) {
        const state = durableSeam.resolveDurableState(index, { ...identity, sourceFingerprint: fingerprint, action: currentAction });
        expect(state.kind).toBe("legacy_unverified");
        expect(durableSeam.projectResult(state, context()).executed).toBe(false);
      }
    }
  });

  it.each([undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("records transport issueNumber %s and permits a non-mutating next run", async (issueNumber) => {
    const value = fixture();
    value.plan.entries[0].approved = true;
    value.persistPlan();
    const transport = fakeTransport();
    vi.mocked(transport.createIssue).mockResolvedValue({ issueNumber, issueId: "I_101" } as never);
    await expect(applyIntakeApprovalPlan({ ...value.execution, planPath: value.planPath,
      execute: true, trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, transport, now: NOW })).resolves.toMatchObject({
      failures: [{ sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue", stage: "dispatch",
        issueNumber: null, error: expect.stringMatching(/issue number/) }],
    });
    const rows = readFileSync(value.journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.map((row) => row.event)).toEqual(["intent", "create_unresolved", undefined, undefined]);
    expect(rows[1]).toMatchObject({ issueNumber: null, issueId: "I_101" });
    const state = durableSeam.resolveDurableState(durableSeam.indexHistory(rows), identity);
    expect(state.kind).toBe("unresolved_partial");
    expect(durableSeam.projectResult(state, context()).result).toEqual({ issueNumber: null, issueId: "I_101", commentId: null });
    const retry = executeCli(value);
    const result = await retry.result;
    expect(result.ledgerRecords[0]).toMatchObject({ executed: false, disposition: "refused", result: { issueId: "I_101" } });
    expect(retry.transport.createIssue).not.toHaveBeenCalled();
    expect(retry.transport.preflightClassifications).not.toHaveBeenCalled();
  });

  it("projects unparseable JSON history through CLI without dispatch or a crash", async () => {
    const value = fixture();
    value.plan.entries[0].approved = true;
    value.persistPlan();
    writeFileSync(value.journalPath, '{"event":\n', "utf8");
    const cli = executeCli(value);
    const result = await cli.result;
    expect(result.ledgerRecords.every((record) => record.durableState === "malformed")).toBe(true);
    expect(cli.transport.createIssue).not.toHaveBeenCalled();
    expect(cli.transport.preflightClassifications).not.toHaveBeenCalled();
    expect(readFileSync(value.journalPath, "utf8")).toBe('{"event":\n');
  });

  it("records recovery read-back failure and continues the later plan loop", async () => {
    const value = fixture();
    value.plan.entries[1].approved = true;
    value.persistPlan();
    writeFileSync(value.journalPath, JSON.stringify(durableEvent("created", { issueNumber: 101, issueId: "I_101" })) + "\n", "utf8");
    const transport = fakeTransport();
    vi.mocked(transport.verifyClassifications).mockRejectedValueOnce(new Error("read-back unavailable"));
    const result = await applyIntakeApprovalPlan({ ...value.execution, planPath: value.planPath,
      execute: true, trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, transport, now: NOW });
    expect(result.failures).toEqual([{ sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue",
      stage: "recovery", issueNumber: 101, error: "Classification read-back unavailable: read-back unavailable" }]);
    expect(transport.applyClassification).toHaveBeenCalledExactlyOnceWith("example-org/example-repo", 101, { fieldName: "Priority", value: "P2" }, expect.any(Function));
    expect(transport.appendEvidenceComment).toHaveBeenCalledExactlyOnceWith("example-org/example-repo", 42,
      value.plan.entries[1].evidenceComment, expect.any(Function));
    const rows = readFileSync(value.journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.map((row) => row.event)).toEqual(["created", "classification_failed", "intent", "created", "complete", undefined]);
    expect(rows[1].decisionContentSha256).toBe("b".repeat(64));
    expect(result.ledgerRecords.map((row) => row.durableState)).toEqual(["classification_failed", "complete", "never_attempted"]);
  });
});

function executeCli(value: ReturnType<typeof fixture>, options: {
  readonly flags?: readonly string[];
  readonly runGit?: typeof fakeGit;
  readonly sha?: string;
  readonly transport?: OperatorIntakeApprovalTransport;
  readonly log?: (line: string) => void;
  readonly actionQualificationContext?: ActionQualificationContext;
} = {}) {
  const transport = options.transport ?? fakeTransport();
  const openTransport = vi.fn(() => transport);
  const runGit = vi.fn(options.runGit ?? fakeGit);
  const result = runIntakeApplyCli({
    argv: [`--plan=${value.planPath}`, "--execute", `--run-evidence=${value.runEvidencePath}`,
      `--origin-main-sha=${options.sha ?? ADVANCED_SHA}`,
      ...(options.flags ?? [`--candidate=${value.candidatePath}`, `--existence=${value.existencePath}`])],
    operatorToken: "operator-secret", openTransport, repoRoot: value.root, runGit, log: options.log ?? (() => undefined),
    dispositionHistory: emptyDispositionHistory,
    actionQualificationContext: options.actionQualificationContext,
  });
  return { result, transport, openTransport, runGit };
}
// Private captured-fixture replay is excluded from this public source copy.


describe("plan-scoped recovery and operation failure isolation", () => {
  function prepare(source: ReturnType<typeof report>, approve = false) {
    const value = fixture();
    value.decisionContent = JSON.stringify(source);
    writeFileSync(value.decisionPath, value.decisionContent, "utf8");
    Object.assign(value.plan, buildIntakeApprovalPlan({
      decisionPath: value.decisionPath, decisionContent: value.decisionContent, now: NOW,
    }));
    for (const entry of value.plan.entries) entry.approved = approve && entry.approvable;
    value.persistPlan();
    return value;
  }

  function creates(count = 3) {
    const source = report();
    source.candidates = source.candidates.slice(0, count).map((candidate) => ({
      ...candidate, presentation: "draft", hold: null,
      draft: draft(candidate.sourceFingerprint, "create_issue", null),
    }));
    return prepare(source, true);
  }

  function historyBytes(value: ReturnType<typeof fixture>, fingerprint: string) {
    return Buffer.from(readFileSync(value.journalPath, "utf8").split(/(?<=\n)/)
      .filter((line) => line.trim() !== "" && JSON.parse(line).sourceFingerprint === fingerprint).join(""));
  }

  it.each([
    { name: "same legacy issue", priorState: "legacy_unverified", expected: "abandoned",
      retained: { issueNumber: 1777, issueId: "I_1777", commentId: null },
      late: { issueNumber: 1777, issueId: "I_1777", commentId: null } },
    { name: "null legacy identity", priorState: "legacy_unverified", expected: "abandoned",
      retained: { issueNumber: null, issueId: null, commentId: null },
      late: { issueNumber: null, issueId: null, commentId: null } },
    { name: "different legacy issue", priorState: "legacy_unverified", expected: "conflict",
      retained: { issueNumber: 1777, issueId: "I_1777", commentId: null },
      late: { issueNumber: 1778, issueId: "I_1778", commentId: null } },
    { name: "staged-origin abandonment", priorState: "unresolved_unknown", expected: "conflict",
      retained: { issueNumber: null, issueId: null, commentId: null },
      late: { issueNumber: 1777, issueId: "I_1777", commentId: null } },
  ])("projects late legacy evidence through status and refuses apply: $name", async ({ priorState, expected, retained, late }) => {
    const value = creates(1);
    if (priorState === "legacy_unverified") {
      const original = join(value.root, "original-legacy.jsonl");
      writeFileSync(original, JSON.stringify(legacyExecution({ result: retained })) + "\n");
      const imported = await applyIntakeApprovalPlan({ planPath: value.planPath, importLedgerPaths: [original] });
      expect(imported.importedLedgers?.imported).toBe(1);
    } else writeFileSync(value.journalPath, JSON.stringify(durableEvent("create_unresolved")) + "\n");
    expect(runIntakeResolveCli({ argv: ["abandon", "--repository=example-org/example-repo",
      `--source-fingerprint=${CREATE_FINGERPRINT}`, "--action=create_issue", `--expected-state=${priorState}`,
      "--reason=Stop pursuing", "--execute"], now: NOW, log: () => undefined, error: () => undefined })).toBe(0);
    const beforeImport = readFileSync(value.journalPath);
    const copy = join(value.root, "copy-legacy.jsonl");
    writeFileSync(copy, JSON.stringify(legacyExecution({ result: late })) + "\n");
    const imported = await applyIntakeApprovalPlan({ planPath: value.planPath, importLedgerPaths: [copy] });
    expect(imported.importedLedgers?.imported).toBe(1);
    expect(readFileSync(value.journalPath).subarray(0, beforeImport.length)).toEqual(beforeImport);
    const state = durableSeam.resolveDurableState(durableSeam.indexHistory(readJournal(value.journalPath).records), {
      repository: "example-org/example-repo", sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue",
    });
    expect(state.kind).toBe(expected);
    const log = vi.fn();
    expect(runIntakeResolveCli({ argv: ["status", "--repository=example-org/example-repo"], now: NOW, log })).toBe(0);
    const operations = JSON.parse(log.mock.calls[0][0]).operations;
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue", state: expected });
    if (expected === "abandoned") expect(operations[0]).toMatchObject(retained);
    const beforeApply = readFileSync(value.journalPath);
    const cli = executeCli(value);
    const result = await cli.result;
    expect(result.ledgerRecords).toHaveLength(1);
    expect(result.ledgerRecords[0]).toMatchObject({ durableState: expected, executed: false,
      disposition: expected === "abandoned" ? "abandoned" : "refused", actionTaken: null, actionsTaken: [],
      result: expected === "abandoned" ? retained : { issueNumber: null, issueId: null, commentId: null } });
    expect(cli.openTransport).not.toHaveBeenCalled();
    for (const method of Object.values(cli.transport)) expect(method).not.toHaveBeenCalled();
    expect(readFileSync(value.journalPath)).toEqual(beforeApply);
  });

  it.each(["create_issue", "append_evidence"] as const)("refuses %s after a compatible executed legacy row is imported after abandonment", async (action) => {
    const source = report();
    source.candidates = [source.candidates[action === "create_issue" ? 0 : 1]];
    const fingerprint = source.candidates[0].sourceFingerprint;
    const value = prepare(source, true);
    const retained = { issueNumber: 101, issueId: "I_101", commentId: "IC_101" };
    writeFileSync(value.journalPath, JSON.stringify(durableEvent("classification_failed", {
      sourceFingerprint: fingerprint, action, ...retained,
      payload: { issue: action === "create_issue" ? value.plan.entries[0].issue : null,
        evidenceComment: action === "append_evidence" ? value.plan.entries[0].evidenceComment : null, closeIssue: null },
    })) + "\n");
    expect(runIntakeResolveCli({ argv: ["abandon", "--repository=example-org/example-repo",
      `--source-fingerprint=${fingerprint}`, `--action=${action}`, "--expected-state=classification_failed",
      "--reason=Stop pursuing", "--execute"], now: NOW, log: () => undefined, error: () => undefined })).toBe(0);
    const beforeImport = readFileSync(value.journalPath);
    const ledger = join(value.root, "late-legacy.jsonl");
    writeFileSync(ledger, JSON.stringify(legacyExecution({ sourceFingerprint: fingerprint, candidateFingerprint: fingerprint,
      actionTaken: action, intendedAction: action, result: retained, appliedAt: "2026-01-01T00:00:00.000Z" })) + "\n");
    const imported = await applyIntakeApprovalPlan({ planPath: value.planPath, importLedgerPaths: [ledger] });
    expect(imported.importedLedgers?.imported).toBe(1);
    expect(readFileSync(value.journalPath).subarray(0, beforeImport.length)).toEqual(beforeImport);
    const state = durableSeam.resolveDurableState(durableSeam.indexHistory(readJournal(value.journalPath).records), {
      repository: "example-org/example-repo", sourceFingerprint: fingerprint, action,
    });
    const conflict = { reason: "Abandoned operation has a later legacy execution row.",
      left: { event: { event: "abandoned" }, result: retained, history: [{ rowNumber: 1 }, { rowNumber: 2 }] },
      right: { result: retained, history: [{ rowNumber: 3, value: { kind: "legacy_import", row: { executed: true, result: retained } } }] } };
    expect(state).toMatchObject({ kind: "conflict", conflicts: [conflict] });
    const log = vi.fn();
    expect(runIntakeResolveCli({ argv: ["status", "--repository=example-org/example-repo"], now: NOW, log })).toBe(0);
    expect(JSON.parse(log.mock.calls[0][0]).operations).toMatchObject([
      { sourceFingerprint: fingerprint, action, state: "conflict", historyConflicts: [conflict] },
    ]);
    const beforeApply = readFileSync(value.journalPath);
    const cli = executeCli(value);
    const result = await cli.result;
    expect(result.ledgerRecords).toHaveLength(1);
    expect(result.ledgerRecords[0]).toMatchObject({ durableState: "conflict", executed: false, disposition: "refused",
      actionTaken: null, actionsTaken: [], result: { issueNumber: null, issueId: null, commentId: null }, historyConflicts: [conflict] });
    expect(cli.openTransport).not.toHaveBeenCalled();
    for (const method of Object.values(cli.transport)) expect(method).not.toHaveBeenCalled();
    expect(readFileSync(value.journalPath)).toEqual(beforeApply);
  });

  it.each([
    { kind: "intent_unknown", rows: () => [durableEvent("intent")] },
    { kind: "primary_unverified", rows: () => [durableEvent("created", { issueNumber: 101, issueId: "I_101" })] },
    { kind: "classification_failed", rows: () => [durableEvent("classification_failed", { issueNumber: 101, issueId: "I_101" })] },
    { kind: "unresolved_unknown", rows: () => [durableEvent("create_unresolved")] },
    { kind: "unresolved_partial", rows: () => [durableEvent("create_unresolved", { issueNumber: 101, issueId: "I_101" })] },
    { kind: "legacy_unverified", rows: () => [legacyExecution({ decisionContentSha256: null, emissionContentSha256: null })] },
  ])("never selects, reduces or dispatches abandoned $kind even when a new emission is approved", async ({ kind, rows }) => {
    const value = creates(1);
    writeFileSync(value.journalPath, rows().map((row) => JSON.stringify(row) + "\n").join(""));
    const reason = "Stop pursuing; the request might still land.";
    expect(runIntakeResolveCli({ argv: ["abandon", "--repository=example-org/example-repo",
      `--source-fingerprint=${CREATE_FINGERPRINT}`, "--action=create_issue", `--expected-state=${kind}`,
      `--reason=${reason}`, "--execute"], now: NOW, log: () => undefined, error: () => undefined })).toBe(0);
    const before = readFileSync(value.journalPath);
    const retained = (durableSeam.resolveDurableState(durableSeam.indexHistory(readJournal(value.journalPath).records), {
      repository: "example-org/example-repo", sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue",
    }) as Extract<durableSeam.DurableState, { kind: "abandoned" }>).operation.result;
    const source = JSON.parse(value.decisionContent) as ReturnType<typeof report>;
    source.candidates[0].draft!.issue.title = "A revised emission of the same outcome";
    for (const target of [source.candidates[0].draft!]) {
      target.marker = target.marker.replace(/^emission-content-sha256: [0-9a-f]{64}$/m, `emission-content-sha256: ${"f".repeat(64)}`);
      target.issue.body = target.issue.body.replace(/^emission-content-sha256: [0-9a-f]{64}$/m, `emission-content-sha256: ${"f".repeat(64)}`);
    }
    value.decisionContent = JSON.stringify(source);
    writeFileSync(value.decisionPath, value.decisionContent);
    const plan = buildIntakeApprovalPlan({ decisionPath: value.decisionPath, decisionContent: value.decisionContent, now: NOW });
    plan.entries[0].approved = true;
    writeFileSync(value.planPath, JSON.stringify(plan));
    writeRunEvidenceFixture(value.planPath, EVIDENCE_CENSUS, true);
    const log = vi.fn();
    const cli = executeCli(value, { log });
    const result = await cli.result;
    expect(result.ledgerRecords).toHaveLength(1);
    expect(result.ledgerRecords[0]).toMatchObject({ durableState: "abandoned", executed: false, disposition: "abandoned",
      actionTaken: null, actionsTaken: [], result: retained, abandonment: { reason } });
    expect(result.failures).toEqual([]);
    expect(cli.openTransport).not.toHaveBeenCalled();
    for (const method of Object.values(cli.transport)) expect(method).not.toHaveBeenCalled();
    expect(readFileSync(value.journalPath)).toEqual(before);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual(result);
    const preview = await applyIntakeApprovalPlan({ planPath: value.planPath });
    expect(preview.ledgerRecords[0]).toMatchObject({ executed: false, disposition: "abandoned", abandonment: { reason }, result: retained });
    expect(readFileSync(value.journalPath)).toEqual(before);
  });

  it("never recovers, reappends, or closes an abandoned evidence operation", async () => {
    const source = report();
    source.candidates = [source.candidates[1]];
    const value = prepare(source, true);
    const retained = { issueNumber: 42, issueId: "I_42", commentId: "IC_42" };
    const payload = { issue: null, evidenceComment: value.plan.entries[0].evidenceComment, closeIssue: {
      targetIssueNumber: 42, before: "OPEN", after: "CLOSED", evidenceIds: ["append-proof"],
    } };
    writeFileSync(value.journalPath, JSON.stringify(durableEvent("classification_failed", {
      sourceFingerprint: APPEND_FINGERPRINT, action: "append_evidence", payload, ...retained,
    })) + "\n");
    const reason = "Stop pursuing this evidence operation.";
    expect(runIntakeResolveCli({ argv: ["abandon", "--repository=example-org/example-repo",
      `--source-fingerprint=${APPEND_FINGERPRINT}`, "--action=append_evidence", "--expected-state=classification_failed",
      `--reason=${reason}`, "--execute"], now: NOW, log: () => undefined, error: () => undefined })).toBe(0);
    const before = readFileSync(value.journalPath);
    const cli = executeCli(value);
    const result = await cli.result;
    expect(result.ledgerRecords).toHaveLength(1);
    expect(result.ledgerRecords[0]).toMatchObject({ durableState: "abandoned", executed: false, disposition: "abandoned",
      actionTaken: null, actionsTaken: [], result: retained, abandonment: { reason } });
    expect(result.failures).toEqual([]);
    expect(cli.openTransport).not.toHaveBeenCalled();
    for (const method of Object.values(cli.transport)) expect(method).not.toHaveBeenCalled();
    expect(readFileSync(value.journalPath)).toEqual(before);
  });

  it("refuses emission B after abandoning an append for emission A without opening transport", async () => {
    const source = report();
    source.candidates = [source.candidates[1]];
    const value = prepare(source, true);
    const emissionA = /^emission-content-sha256: ([a-f0-9]{64})$/m.exec(value.plan.entries[0].evidenceComment!)![1];
    const emissionB = "f".repeat(64);
    expect(emissionA).not.toBe(emissionB);
    writeFileSync(value.journalPath, JSON.stringify(durableEvent("classification_failed", {
      sourceFingerprint: APPEND_FINGERPRINT, action: "append_evidence", emissionContentSha256: emissionA,
      payload: { issue: null, evidenceComment: value.plan.entries[0].evidenceComment, closeIssue: null },
      issueNumber: 42, issueId: "I_42", commentId: "IC_42",
    })) + "\n");
    expect(runIntakeResolveCli({ argv: ["abandon", "--repository=example-org/example-repo",
      `--source-fingerprint=${APPEND_FINGERPRINT}`, "--action=append_evidence", "--expected-state=classification_failed",
      "--reason=Stop pursuing emission A", "--execute"], now: NOW, log: () => undefined, error: () => undefined })).toBe(0);
    const before = readFileSync(value.journalPath);
    const revised = JSON.parse(value.decisionContent) as ReturnType<typeof report>;
    const target = revised.candidates[0].draft!;
    target.marker = target.marker.replace(emissionA, emissionB);
    target.issue.body = target.issue.body.replace(emissionA, emissionB);
    target.evidenceComment = target.evidenceComment.replace(emissionA, emissionB);
    value.decisionContent = JSON.stringify(revised);
    writeFileSync(value.decisionPath, value.decisionContent);
    Object.assign(value.plan, buildIntakeApprovalPlan({ decisionPath: value.decisionPath,
      decisionContent: value.decisionContent, now: NOW }));
    value.plan.entries[0].approved = true;
    value.persistPlan();

    const cli = executeCli(value);
    const result = await cli.result;
    expect(result.ledgerRecords[0]).toMatchObject({ durableState: "abandoned", executed: false, disposition: "abandoned",
      actionTaken: null, actionsTaken: [], abandonment: { reason: "Stop pursuing emission A" } });
    expect(cli.openTransport).not.toHaveBeenCalled();
    for (const method of Object.values(cli.transport)) expect(method).not.toHaveBeenCalled();
    expect(readFileSync(value.journalPath)).toEqual(before);
  });

  it("neither counts nor resets a dispatch failure across a recovery failure", () => {
    const breaker = new IntakeExecutionBreaker();
    const failure = { sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue" as const,
      stage: "dispatch" as const, issueNumber: null, error: "dispatch failed" };
    const dispatchError = Object.assign(new Error(failure.error), { status: 404 });
    breaker.recordFailure(failure, dispatchError);
    expect(breaker.aborted).toBeUndefined();
    breaker.recordFailure({ ...failure, sourceFingerprint: APPEND_FINGERPRINT, stage: "recovery", error: "retired option" },
      Object.assign(new Error("retired option"), { status: 422 }));
    expect(breaker.aborted).toBeUndefined();
    breaker.recordFailure({ ...failure, sourceFingerprint: HOLD_FINGERPRINT }, dispatchError);
    expect(breaker.aborted).toEqual({ stage: "dispatch", sourceFingerprint: HOLD_FINGERPRINT,
      reason: "repeated_fault", error: "dispatch failed" });
  });

  it("counts a fresh-dispatch classification failure toward the same breaker as a dispatch failure", () => {
    // A landed create whose classification is rejected is not re-attempted this run, so two in a
    // row are the same amplification a dead transport produces; recovery-stage failures are not.
    const breaker = new IntakeExecutionBreaker();
    const failure = { sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue" as const,
      stage: "dispatch" as const, issueNumber: null, error: "dispatch failed" };
    breaker.recordFailure(failure, Object.assign(new Error(failure.error), { status: 404 }));
    expect(breaker.aborted).toBeUndefined();
    breaker.recordFailure({ ...failure, sourceFingerprint: APPEND_FINGERPRINT, stage: "classification", issueNumber: 202, error: "retired option" },
      Object.assign(new Error("retired option"), { status: 422 }));
    expect(breaker.aborted).toEqual({ stage: "classification", sourceFingerprint: APPEND_FINGERPRINT,
      reason: "repeated_fault", error: "retired option" });
  });

  it.each(["recovery", "classification"] as const)("only resets dispatch failures for a fresh durable complete (stage=%s)", (stage) => {
    const breaker = new IntakeExecutionBreaker();
    const failure = { sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue" as const,
      stage: "dispatch" as const, issueNumber: null, error: "dispatch failed" };
    const error = Object.assign(new Error(failure.error), { status: 404 });
    breaker.recordFailure(failure, error);
    breaker.recordComplete(stage);
    breaker.recordFailure(failure, error);
    if (stage === "recovery") expect(breaker.aborted).toMatchObject({ reason: "repeated_fault" });
    else expect(breaker.aborted).toBeUndefined();
  });

  it("preserves the first abort when later failures report other abort reasons", () => {
    const breaker = new IntakeExecutionBreaker();
    const failure = { sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue" as const,
      stage: "dispatch" as const, issueNumber: null, error: "unauthorized" };
    breaker.recordFailure(failure, Object.assign(new Error(failure.error), { status: 401 }));
    const firstAbort = breaker.aborted;
    breaker.recordFailure({ ...failure, sourceFingerprint: APPEND_FINGERPRINT, error: "missing issue" },
      Object.assign(new Error("missing issue"), { status: 404 }));
    breaker.recordFailure({ ...failure, stage: "recovery", error: "rate limited" },
      Object.assign(new Error("rate limited"), { status: 429 }));
    expect(firstAbort).toEqual({ stage: "dispatch", sourceFingerprint: CREATE_FINGERPRINT,
      reason: "session_scope_fault", error: "unauthorized" });
    expect(breaker.aborted).toBe(firstAbort);
  });

  it("retries two deterministic recovery failures without aborting or starving an approved create", async () => {
    const value = creates();
    const rows = value.plan.entries.slice(0, 2).map((entry, index) => durableEvent("classification_failed", {
      sourceFingerprint: entry.sourceFingerprint, issueNumber: 101 + index, issueId: `I_${101 + index}`,
      payload: { issue: entry.issue, evidenceComment: null, closeIssue: null },
    }));
    writeFileSync(value.journalPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    for (const run of [1, 2]) {
      const transport = fakeTransport();
      vi.mocked(transport.applyClassification)
        .mockRejectedValueOnce(Object.assign(new Error("retired option"), { status: 422 }))
        .mockRejectedValueOnce(Object.assign(new Error("deleted issue"), { status: 422 }));
      vi.mocked(transport.createIssue).mockResolvedValueOnce({ issueNumber: 303 });
      const result = await executeCli(value, { transport }).result;
      expect(result).not.toHaveProperty("aborted");
      expect(result.failures).toHaveLength(2);
      expect(result.failures.map((failure) => [failure.stage, failure.issueNumber, failure.error]))
        .toEqual([["recovery", 101, "retired option"], ["recovery", 102, "deleted issue"]]);
      expect(result.ledgerRecords.map((row) => row.durableState)).toEqual(["classification_failed", "classification_failed", "complete"]);
      for (const record of result.ledgerRecords) expect(record).not.toHaveProperty("skippedDueToAbort");
      expect(transport.createIssue).toHaveBeenCalledTimes(run === 1 ? 1 : 0);
      expect(process.exitCode).toBe(1);
    }
    expect((readJournal(value.journalPath).records as Record<string, unknown>[]).map((row) => row.event))
      .toEqual(["classification_failed", "classification_failed", "classification_failed", "classification_failed",
        "intent", "created", "complete", "classification_failed", "classification_failed"]);
  });

  it.each([false, true])("tags fingerprint siblings by entry key after an abort (approved sibling transitioned=%s)", async (transitioned) => {
    const value = creates();
    const secondDecision = join(value.root, "decision-two.json");
    const secondSource = report();
    secondSource.candidates = [secondSource.candidates[0]];
    writeFileSync(secondDecision, JSON.stringify(secondSource));
    const plan = runIntakeApproveCli({
      argv: [`--decision=${value.decisionPath}`, `--decision=${secondDecision}`, `--out=${value.planPath}`], now: NOW,
    });
    const failingFingerprint = transitioned ? CREATE_FINGERPRINT : APPEND_FINGERPRINT;
    for (const entry of plan.entries) {
      entry.approved = entry.sourceFingerprint === failingFingerprint && entry.decisionReport.path === value.decisionPath;
    }
    plan.entries.sort((left, right) => Number(right.approved) - Number(left.approved));
    writeFileSync(value.planPath, JSON.stringify(plan));
    writeRunEvidenceFixture(value.planPath, EVIDENCE_CENSUS, true);
    const transport = fakeTransport();
    vi.mocked(transport.createIssue).mockRejectedValueOnce(Object.assign(new Error("unavailable"), { status: 503 }));
    const result = await executeCli(value, { transport }).result;
    const siblings = result.ledgerRecords.filter((record) => record.sourceFingerprint === CREATE_FINGERPRINT);
    expect(plan.entries.filter((entry) => entry.sourceFingerprint === CREATE_FINGERPRINT)
      .map((entry) => entry.decisionReport.path)).toEqual([value.decisionPath, secondDecision]);
    expect(siblings.map((record) => record.skippedDueToAbort === true)).toEqual(transitioned ? [false, true] : [true, true]);
    expect(siblings.map((record) => record.durableState))
      .toEqual(transitioned ? ["unresolved_unknown", "unresolved_unknown"] : ["never_attempted", "never_attempted"]);
    expect(result.aborted).toMatchObject({ sourceFingerprint: failingFingerprint, reason: "session_scope_fault" });
    expect(result.failures).toHaveLength(1);
    expect(transport.createIssue).toHaveBeenCalledTimes(1);
    expect(readJournal(value.journalPath).records).toEqual([
      expect.objectContaining({ sourceFingerprint: failingFingerprint, event: "intent" }),
      expect.objectContaining({ sourceFingerprint: failingFingerprint, event: "create_unresolved" }),
    ]);
  });

  it.each(["complete", "never_attempted"])("projects a missing identity untagged with durable state %s after an abort", async (state) => {
    const value = creates(2);
    const missingKey = `${value.decisionPath}\0${APPEND_FINGERPRINT}`;
    const rows = state === "complete" ? [durableEvent("complete", {
      sourceFingerprint: APPEND_FINGERPRINT, issueNumber: 202, issueId: "I_202",
      payload: { issue: value.plan.entries[1].issue, evidenceComment: null, closeIssue: null },
    })] : [];
    if (rows.length > 0) writeFileSync(value.journalPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const transport = fakeTransport();
    let misses = 0;
    vi.mocked(transport.createIssue).mockImplementationOnce(async () => {
      const get = Map.prototype.get;
      vi.spyOn(Map.prototype, "get").mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
        const value: unknown = get.call(this, key);
        if (key === missingKey && value !== null && typeof value === "object"
          && "repository" in value && "action" in value && Object.keys(value).length === 3) {
          misses += 1;
          return undefined;
        }
        return value;
      });
      throw Object.assign(new Error("unauthorized"), { status: 401 });
    });
    const result = await executeCli(value, { transport }).result;
    expect(misses).toBe(1);
    expect(result.failures).toEqual([
      { sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue", stage: "dispatch", issueNumber: null, error: "unauthorized" },
      { sourceFingerprint: APPEND_FINGERPRINT, action: "create_issue", stage: "projection",
        issueNumber: state === "complete" ? 202 : null, error: `Missing history identity for approval entry ${missingKey}.` },
    ]);
    expect(result.ledgerRecords[1].durableState).toBe(state);
    expect(result.ledgerRecords[1].result).toEqual({ issueNumber: state === "complete" ? 202 : null,
      issueId: state === "complete" ? "I_202" : null, commentId: null });
    expect(result.ledgerRecords[1]).not.toHaveProperty("skippedDueToAbort");
    expect(result.aborted).toEqual({ stage: "dispatch", sourceFingerprint: CREATE_FINGERPRINT,
      reason: "session_scope_fault", error: "unauthorized" });
    expect(transport.createIssue).toHaveBeenCalledTimes(1);
    expect(readJournal(value.journalPath).records).toEqual([...rows,
      expect.objectContaining({ sourceFingerprint: CREATE_FINGERPRINT, event: "intent" }),
      expect.objectContaining({ sourceFingerprint: CREATE_FINGERPRINT, event: "create_unresolved" }),
    ]);
    expect(process.exitCode).toBe(1);
  });

  it.each(["created", "classification_failed", "intent"])(
    "recovers only plan F1 and leaves F2 %s history byte-identical with zero transport calls", async (event) => {
      const source = report();
      source.candidates = [source.candidates[0]];
      const value = prepare(source);
      const rows = [
        durableEvent("created", { repository: "example-org/example-repo", issueNumber: 101, issueId: "I_101" }),
        durableEvent(event, { sourceFingerprint: APPEND_FINGERPRINT,
          payload: { issue: draft(APPEND_FINGERPRINT, "create_issue", null).issue, evidenceComment: null, closeIssue: null },
          issueNumber: event === "intent" ? null : 202, issueId: event === "intent" ? null : "I_202" }),
      ];
      writeFileSync(value.journalPath, rows.map((row) => JSON.stringify(row)).join("\r\n") + "\r\n", "utf8");
      const before = historyBytes(value, APPEND_FINGERPRINT);
      const cli = executeCli(value);
      const result = await cli.result;
      expect(result.failures).toEqual([]);
      expect(result.ledgerRecords).toHaveLength(1);
      expect(result.ledgerRecords[0].durableState).toBe("complete");
      expect(historyBytes(value, APPEND_FINGERPRINT)).toEqual(before);
      expect(readJournal(value.journalPath).records).toHaveLength(3);
      expect(cli.transport.preflightClassifications).toHaveBeenCalledExactlyOnceWith([{
        repository: "example-org/example-repo", sourceFingerprint: CREATE_FINGERPRINT,
        classifications: [{ fieldName: "Priority", value: "P2" }],
      }]);
      expect(cli.transport.applyClassification).toHaveBeenCalledExactlyOnceWith("example-org/example-repo", 101,
        { fieldName: "Priority", value: "P2" }, expect.any(Function));
      expect(cli.transport.verifyClassifications).toHaveBeenCalledExactlyOnceWith("example-org/example-repo", 101,
        [{ fieldName: "Priority", value: "P2" }]);
      expect(cli.transport.createIssue).not.toHaveBeenCalled();
      expect(cli.transport.appendEvidenceComment).not.toHaveBeenCalled();
      expect(cli.transport.closeIssue).not.toHaveBeenCalled();
      for (const method of Object.values(cli.transport)) {
        expect(JSON.stringify(vi.mocked(method).mock.calls)).not.toContain(APPEND_FINGERPRINT);
      }
    },
  );

  it.each([
    { replay: false, event: "created" }, { replay: true, event: "created" },
    { replay: false, event: "intent" }, { replay: true, event: "intent" },
  ])("scopes historical actions for replay=$replay and other-action $event", async ({ replay, event }) => {
    const source = report();
    source.candidates = [source.candidates[0]];
    if (replay) source.candidates[0] = { ...source.candidates[0], presentation: "replay_no_op", draft: null } as never;
    const value = prepare(source);
    expect(value.plan.entries[0].intendedAction).toBe(replay ? null : "create_issue");
    const otherAction = durableEvent(event, { action: "append_evidence",
      payload: { issue: null, evidenceComment: draft(CREATE_FINGERPRINT, "append_evidence", 202).evidenceComment, closeIssue: null },
      issueNumber: event === "intent" ? null : 202, commentId: event === "intent" ? null : "IC_202" });
    const rows = [durableEvent("created", { issueNumber: 101, issueId: "I_101" }), otherAction];
    writeFileSync(value.journalPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    const cli = executeCli(value);
    const result = await cli.result;
    expect(result.failures).toEqual([]);
    const recorded = readJournal(value.journalPath).records as Record<string, unknown>[];
    expect(recorded.filter((row) => row.action === "create_issue").map((row) => row.event)).toEqual(["created", "complete"]);
    expect(recorded.filter((row) => row.action === "append_evidence").map((row) => row.event))
      .toEqual(replay ? [event, event === "intent" ? "create_unresolved" : "complete"] : [event]);
    expect(cli.transport.applyClassification).toHaveBeenCalledTimes(replay && event === "created" ? 2 : 1);
    expect(cli.transport.preflightClassifications).toHaveBeenCalledExactlyOnceWith(
      Array.from({ length: replay && event === "created" ? 2 : 1 }, () => ({
        sourceFingerprint: CREATE_FINGERPRINT, repository: "example-org/example-repo",
        classifications: [{ fieldName: "Priority", value: "P2" }],
      })),
    );
    expect(cli.transport.createIssue).not.toHaveBeenCalled();
    expect(cli.transport.appendEvidenceComment).not.toHaveBeenCalled();
    expect(cli.transport.closeIssue).not.toHaveBeenCalled();
  });

  it("creates the first and third entries after the second create fails, prints the full result and exits 1", async () => {
    const value = creates();
    const transport = fakeTransport();
    vi.mocked(transport.createIssue).mockResolvedValueOnce({ issueNumber: 101 })
      .mockRejectedValueOnce(new Error("second create unavailable"))
      .mockResolvedValueOnce({ issueNumber: 303 });
    const log = vi.fn();
    const result = await executeCli(value, { transport, log }).result;
    expect(transport.createIssue).toHaveBeenCalledTimes(3);
    expect(vi.mocked(transport.createIssue).mock.calls.map((call) => call[1].body))
      .toEqual(value.plan.entries.map((entry) => entry.issue!.body));
    expect(result.failures).toEqual([{ sourceFingerprint: APPEND_FINGERPRINT, action: "create_issue",
      stage: "dispatch", issueNumber: null, error: "second create unavailable" }]);
    expect(result.ledgerRecords.map((row) => row.durableState)).toEqual(["complete", "unresolved_unknown", "complete"]);
    expect(result.executionSummary).toMatchObject({ operationsTotal: 3, unresolved: 1,
      countsByState: { complete: 2, unresolved_unknown: 1 } });
    expect(result.ledgerRecords.map((row) => row.result.issueNumber)).toEqual([101, null, 303]);
    expect((readJournal(value.journalPath).records as Record<string, unknown>[]).map((row) => row.event))
      .toEqual(["intent", "created", "complete", "intent", "create_unresolved", "intent", "created", "complete"]);
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(result, null, 2));
    expect(process.exitCode).toBe(1);
    expect(result).not.toHaveProperty("aborted");
  });

  it.each([401, 403, 429, 500, 503, null])(
    "stops after the second create's session fault (status %s), leaves the third untouched and dispatches it next run", async (status) => {
      const value = creates();
      const transport = fakeTransport();
      const error = Object.assign(new Error("second create unavailable"), { status });
      vi.mocked(transport.createIssue).mockResolvedValueOnce({ issueNumber: 101 })
        .mockRejectedValueOnce(error);
      const log = vi.fn();
      const result = await executeCli(value, { transport, log }).result;
      expect(transport.createIssue).toHaveBeenCalledTimes(2);
      expect(vi.mocked(transport.createIssue).mock.calls.map((call) => call[1].body))
        .toEqual(value.plan.entries.slice(0, 2).map((entry) => entry.issue!.body));
      expect(result.failures).toEqual([{ sourceFingerprint: APPEND_FINGERPRINT, action: "create_issue",
        stage: "dispatch", issueNumber: null, error: error.message }]);
      expect(result.aborted).toEqual({ stage: "dispatch", sourceFingerprint: APPEND_FINGERPRINT,
        reason: "session_scope_fault", error: error.message });
      expect(result.ledgerRecords.map((row) => row.durableState)).toEqual(["complete", "unresolved_unknown", "never_attempted"]);
      expect(result.executionSummary).toMatchObject({ operationsTotal: 2, unresolved: 1,
        countsByState: { complete: 1, unresolved_unknown: 1, never_attempted: 0 } });
      expect(JSON.parse(log.mock.calls[0][0]).executionSummary).toEqual(result.executionSummary);
      expect(result.ledgerRecords.map((row) => row.result.issueNumber)).toEqual([101, null, null]);
      expect(result.ledgerRecords[2]).toHaveProperty("skippedDueToAbort", true);
      for (const record of result.ledgerRecords.slice(0, 2)) expect(record).not.toHaveProperty("skippedDueToAbort");
      const rows = readJournal(value.journalPath).records as Record<string, unknown>[];
      expect(rows.map((row) => row.event)).toEqual(["intent", "created", "complete", "intent", "create_unresolved"]);
      expect(rows.some((row) => row.sourceFingerprint === HOLD_FINGERPRINT)).toBe(false);
      expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(result, null, 2));
      expect(JSON.parse(log.mock.calls[0][0]).ledgerRecords[2]).toHaveProperty("skippedDueToAbort", true);
      expect(process.exitCode).toBe(1);

      const before = readFileSync(value.journalPath);
      const preview = await applyIntakeApprovalPlan({ planPath: value.planPath, now: NOW });
      expect(preview.ledgerRecords.map((row) => row.durableState)).toEqual(result.ledgerRecords.map((row) => row.durableState));
      expect(preview.executionSummary.countsByState).toEqual(result.executionSummary.countsByState);
      expect(readFileSync(value.journalPath)).toEqual(before);
      const nextTransport = fakeTransport();
      vi.mocked(nextTransport.createIssue).mockResolvedValueOnce({ issueNumber: 303 });
      const next = await executeCli(value, { transport: nextTransport }).result;
      expect(nextTransport.createIssue).toHaveBeenCalledExactlyOnceWith("example-org/example-repo", value.plan.entries[2].issue, expect.any(Function));
      expect(next.ledgerRecords.map((row) => row.durableState)).toEqual(["complete", "unresolved_unknown", "complete"]);
      expect(next.failures).toEqual([]);
      expect(next).not.toHaveProperty("aborted");
      for (const record of next.ledgerRecords) expect(record).not.toHaveProperty("skippedDueToAbort");
      expect((readJournal(value.journalPath).records as Record<string, unknown>[])
        .filter((row) => row.sourceFingerprint === APPEND_FINGERPRINT).map((row) => row.event))
        .toEqual(["intent", "create_unresolved"]);
    },
  );

  it.each(["404", "plain Error"])(
    "aborts after two consecutive create failures (%s), leaves the third untouched and dispatches it next run", async (shape) => {
      const value = creates();
      const transport = fakeTransport();
      const errors = ["first create failed", "second create failed"].map((message) => shape === "404"
        ? Object.assign(new Error(message), { status: 404 }) : new Error(message));
      vi.mocked(transport.createIssue).mockRejectedValueOnce(errors[0]).mockRejectedValueOnce(errors[1]);
      const log = vi.fn();
      const result = await executeCli(value, { transport, log }).result;
      expect(transport.createIssue).toHaveBeenCalledTimes(2);
      expect(result.failures).toEqual(value.plan.entries.slice(0, 2).map((entry, index) => ({
        sourceFingerprint: entry.sourceFingerprint, action: "create_issue", stage: "dispatch",
        issueNumber: null, error: errors[index].message,
      })));
      expect(result.aborted).toEqual({ stage: "dispatch", sourceFingerprint: APPEND_FINGERPRINT,
        reason: "repeated_fault", error: errors[1].message });
      expect(result.ledgerRecords.map((row) => row.durableState)).toEqual(["unresolved_unknown", "unresolved_unknown", "never_attempted"]);
      expect(result.executionSummary).toMatchObject({ operationsTotal: 2, unresolved: 2,
        countsByState: { complete: 0, unresolved_unknown: 2, never_attempted: 0 } });
      expect(JSON.parse(log.mock.calls[0][0]).executionSummary).toEqual(result.executionSummary);
      expect(result.ledgerRecords[2]).toHaveProperty("skippedDueToAbort", true);
      for (const record of result.ledgerRecords.slice(0, 2)) expect(record).not.toHaveProperty("skippedDueToAbort");
      const rows = readJournal(value.journalPath).records as Record<string, unknown>[];
      expect(rows.map((row) => row.event)).toEqual(["intent", "create_unresolved", "intent", "create_unresolved"]);
      expect(rows.some((row) => row.sourceFingerprint === HOLD_FINGERPRINT)).toBe(false);
      expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(result, null, 2));
      expect(process.exitCode).toBe(1);

      const before = readFileSync(value.journalPath);
      const nextTransport = fakeTransport();
      vi.mocked(nextTransport.createIssue).mockResolvedValueOnce({ issueNumber: 303 });
      process.exitCode = 0;
      const next = await executeCli(value, { transport: nextTransport }).result;
      expect(nextTransport.createIssue).toHaveBeenCalledExactlyOnceWith("example-org/example-repo", value.plan.entries[2].issue, expect.any(Function));
      expect(next.ledgerRecords.map((row) => row.durableState)).toEqual(["unresolved_unknown", "unresolved_unknown", "complete"]);
      expect(next.failures).toEqual([]);
      expect(next).not.toHaveProperty("aborted");
      for (const record of next.ledgerRecords) expect(record).not.toHaveProperty("skippedDueToAbort");
      expect(readFileSync(value.journalPath).subarray(0, before.length)).toEqual(before);
      expect((readJournal(value.journalPath).records as Record<string, unknown>[]).slice(rows.length).map((row) => row.event))
        .toEqual(["intent", "created", "complete"]);
      expect(process.exitCode).toBe(0);
    },
  );

  it.each(["404", "plain Error"])("resets consecutive failures after a successful create between two failures (%s)", async (shape) => {
    const value = creates();
    const transport = fakeTransport();
    const error = shape === "404" ? Object.assign(new Error("create failed"), { status: 404 }) : new Error("create failed");
    vi.mocked(transport.createIssue).mockRejectedValueOnce(error).mockResolvedValueOnce({ issueNumber: 202 }).mockRejectedValueOnce(error);
    const result = await executeCli(value, { transport }).result;
    expect(transport.createIssue).toHaveBeenCalledTimes(3);
    expect(result.failures).toEqual([CREATE_FINGERPRINT, HOLD_FINGERPRINT].map((sourceFingerprint) => ({
      sourceFingerprint, action: "create_issue", stage: "dispatch", issueNumber: null, error: error.message,
    })));
    expect(result.failures).toHaveLength(2);
    expect(result).not.toHaveProperty("aborted");
    expect(result.ledgerRecords.map((row) => row.durableState)).toEqual(["unresolved_unknown", "complete", "unresolved_unknown"]);
    for (const record of result.ledgerRecords) expect(record).not.toHaveProperty("skippedDueToAbort");
    expect((readJournal(value.journalPath).records as Record<string, unknown>[]).map((row) => row.event))
      .toEqual(["intent", "create_unresolved", "intent", "created", "complete", "intent", "create_unresolved"]);
    expect(process.exitCode).toBe(1);
  });

  it("does not count a recovery failure alongside a dispatch failure and completes the tail", async () => {
    const value = creates();
    writeFileSync(value.journalPath, JSON.stringify(durableEvent("created", { issueNumber: 101, issueId: "I_101" })) + "\n");
    const transport = fakeTransport();
    vi.mocked(transport.applyClassification).mockRejectedValueOnce(new Error("recovery failed"));
    vi.mocked(transport.createIssue).mockRejectedValueOnce(new Error("dispatch failed"));
    const result = await executeCli(value, { transport }).result;
    expect(result.failures).toEqual([
      { sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue", stage: "recovery", issueNumber: 101, error: "recovery failed" },
      { sourceFingerprint: APPEND_FINGERPRINT, action: "create_issue", stage: "dispatch", issueNumber: null, error: "dispatch failed" },
    ]);
    expect(result).not.toHaveProperty("aborted");
    expect(transport.createIssue).toHaveBeenCalledTimes(2);
    expect(transport.createIssue).toHaveBeenNthCalledWith(1, "example-org/example-repo", value.plan.entries[1].issue, expect.any(Function));
    expect(transport.createIssue).toHaveBeenNthCalledWith(2, "example-org/example-repo", value.plan.entries[2].issue, expect.any(Function));
    expect(result.ledgerRecords.map((row) => row.durableState)).toEqual(["classification_failed", "unresolved_unknown", "complete"]);
    for (const record of result.ledgerRecords) expect(record).not.toHaveProperty("skippedDueToAbort");
    const rows = readJournal(value.journalPath).records as Record<string, unknown>[];
    expect(rows.map((row) => row.event)).toEqual(["created", "classification_failed", "intent", "create_unresolved", "intent", "created", "complete"]);
    expect(rows.filter((row) => row.sourceFingerprint === HOLD_FINGERPRINT).map((row) => row.event)).toEqual(["intent", "created", "complete"]);
    expect(process.exitCode).toBe(1);
  });

  it.each(["recovery", "dispatch"])("ignores a recovery failure with a successful %s before a dispatch failure", async (successStage) => {
    const value = creates();
    const rows = value.plan.entries.slice(0, successStage === "recovery" ? 2 : 1).map((entry, index) => durableEvent("created", {
      sourceFingerprint: entry.sourceFingerprint, issueNumber: 101 + index,
      payload: { issue: entry.issue, evidenceComment: null, closeIssue: null },
    }));
    writeFileSync(value.journalPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const transport = fakeTransport();
    vi.mocked(transport.applyClassification).mockRejectedValueOnce(new Error("recovery failed"));
    if (successStage === "dispatch") vi.mocked(transport.createIssue).mockResolvedValueOnce({ issueNumber: 202 });
    vi.mocked(transport.createIssue).mockRejectedValueOnce(new Error("dispatch failed"));
    const result = await executeCli(value, { transport }).result;
    expect(result.failures).toEqual([
      { sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue", stage: "recovery", issueNumber: 101, error: "recovery failed" },
      { sourceFingerprint: HOLD_FINGERPRINT, action: "create_issue", stage: "dispatch", issueNumber: null, error: "dispatch failed" },
    ]);
    expect(result).not.toHaveProperty("aborted");
    expect(result.ledgerRecords.map((row) => row.durableState)).toEqual(["classification_failed", "complete", "unresolved_unknown"]);
    for (const record of result.ledgerRecords) expect(record).not.toHaveProperty("skippedDueToAbort");
    expect(transport.createIssue).toHaveBeenCalledTimes(successStage === "recovery" ? 1 : 2);
    expect(process.exitCode).toBe(1);
  });

  it.each([400, 404, 409, 410, 422, 499])("continues the third create after the second's operation fault (status %s)", async (status) => {
    const value = creates();
    const transport = fakeTransport();
    vi.mocked(transport.createIssue).mockResolvedValueOnce({ issueNumber: 101 })
      .mockRejectedValueOnce(Object.assign(new Error("operation rejected"), { status }))
      .mockResolvedValueOnce({ issueNumber: 303 });
    const result = await executeCli(value, { transport }).result;
    expect(transport.createIssue).toHaveBeenCalledTimes(3);
    expect(result.failures).toEqual([{ sourceFingerprint: APPEND_FINGERPRINT, action: "create_issue",
      stage: "dispatch", issueNumber: null, error: "operation rejected" }]);
    expect(result).not.toHaveProperty("aborted");
    expect(result.ledgerRecords.map((row) => row.durableState)).toEqual(["complete", "unresolved_unknown", "complete"]);
    expect(result.ledgerRecords.map((row) => row.result.issueNumber)).toEqual([101, null, 303]);
    expect((readJournal(value.journalPath).records as Record<string, unknown>[]).map((row) => row.event))
      .toEqual(["intent", "created", "complete", "intent", "create_unresolved", "intent", "created", "complete"]);
    expect(process.exitCode).toBe(1);
  });

  it.each([401, 403, 429, 500, 503, null].flatMap((status) => [false, true].map((thirdRecovery) => ({ status, thirdRecovery }))))(
    "stops after the second recovery's session fault without further recovery or plan intents (status=$status, third recovery=$thirdRecovery)", async ({ status, thirdRecovery }) => {
    const value = creates();
    const rows = value.plan.entries.slice(0, thirdRecovery ? 3 : 2).map((entry, index) => durableEvent("created", {
      sourceFingerprint: entry.sourceFingerprint, issueNumber: 101 + index, issueId: `I_${101 + index}`,
      payload: { issue: entry.issue, evidenceComment: null, closeIssue: null },
    }));
    writeFileSync(value.journalPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const transport = fakeTransport();
    vi.mocked(transport.applyClassification).mockResolvedValueOnce({})
      .mockRejectedValueOnce(Object.assign(new Error("recovery unauthorized"), { status }));
    const result = await executeCli(value, { transport }).result;
    expect(transport.applyClassification).toHaveBeenCalledTimes(2);
    expect(transport.verifyClassifications).toHaveBeenCalledExactlyOnceWith("example-org/example-repo", 101,
      [{ fieldName: "Priority", value: "P2" }]);
    expect(transport.createIssue).not.toHaveBeenCalled();
    expect(result.failures).toEqual([{ sourceFingerprint: APPEND_FINGERPRINT, action: "create_issue",
      stage: "recovery", issueNumber: 102, error: "recovery unauthorized" }]);
    expect(result.aborted).toEqual({ stage: "recovery", sourceFingerprint: APPEND_FINGERPRINT,
      reason: "session_scope_fault", error: "recovery unauthorized" });
    expect(result.ledgerRecords.map((row) => row.durableState))
      .toEqual(["complete", "classification_failed", thirdRecovery ? "primary_unverified" : "never_attempted"]);
    expect(result.executionSummary).toMatchObject({ operationsTotal: thirdRecovery ? 3 : 2,
      unverified: thirdRecovery ? 2 : 1,
      countsByState: { complete: 1, classification_failed: 1, primary_unverified: thirdRecovery ? 1 : 0 } });
    expect(result.ledgerRecords[2]).toHaveProperty("skippedDueToAbort", true);
    for (const record of result.ledgerRecords.slice(0, 2)) expect(record).not.toHaveProperty("skippedDueToAbort");
    expect(readJournal(value.journalPath).records).toEqual([...rows,
      expect.objectContaining({ sourceFingerprint: CREATE_FINGERPRINT, event: "complete" }),
      expect.objectContaining({ sourceFingerprint: APPEND_FINGERPRINT, event: "classification_failed", issueNumber: 102, issueId: "I_102" }),
    ]);
    expect(process.exitCode).toBe(1);
  });

  it.each([401, 403, 429, 500, 503, null])("stops after the second create's classification session fault (status %s)", async (status) => {
    const value = creates();
    const transport = fakeTransport();
    vi.mocked(transport.createIssue).mockResolvedValueOnce({ issueNumber: 101 }).mockResolvedValueOnce({ issueNumber: 202, issueId: "I_202" });
    vi.mocked(transport.applyClassification).mockImplementation(async (_repository, issueNumber) => {
      if (issueNumber === 202) throw Object.assign(new Error("classification unavailable"), { status });
      return {};
    });
    const result = await executeCli(value, { transport }).result;
    expect(transport.createIssue).toHaveBeenCalledTimes(2);
    expect(result.failures).toEqual([{ sourceFingerprint: APPEND_FINGERPRINT, action: "create_issue",
      stage: "classification", issueNumber: 202, error: "classification unavailable" }]);
    expect(result.aborted).toEqual({ stage: "classification", sourceFingerprint: APPEND_FINGERPRINT,
      reason: "session_scope_fault", error: "classification unavailable" });
    expect(result.ledgerRecords.map((row) => row.durableState)).toEqual(["complete", "classification_failed", "never_attempted"]);
    expect(result.ledgerRecords[2]).toHaveProperty("skippedDueToAbort", true);
    for (const record of result.ledgerRecords.slice(0, 2)) expect(record).not.toHaveProperty("skippedDueToAbort");
    expect(result.ledgerRecords[1].result).toEqual({ issueNumber: 202, issueId: "I_202", commentId: null });
    const rows = readJournal(value.journalPath).records as Record<string, unknown>[];
    expect(rows.map((row) => row.event)).toEqual(["intent", "created", "complete", "intent", "created", "classification_failed"]);
    expect(rows.some((row) => row.sourceFingerprint === HOLD_FINGERPRINT)).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("trips the breaker after two consecutive fresh-dispatch classification faults (422) and leaves the third untouched", async () => {
    const value = creates();
    const transport = fakeTransport();
    vi.mocked(transport.createIssue).mockResolvedValueOnce({ issueNumber: 101 }).mockResolvedValueOnce({ issueNumber: 202, issueId: "I_202" });
    vi.mocked(transport.applyClassification).mockRejectedValue(Object.assign(new Error("field option retired"), { status: 422 }));
    const result = await executeCli(value, { transport }).result;
    // Two issues landed unclassified; a third create must not follow the same dead field.
    expect(transport.createIssue).toHaveBeenCalledTimes(2);
    expect(result.failures).toEqual([
      { sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue", stage: "classification", issueNumber: 101, error: "field option retired" },
      { sourceFingerprint: APPEND_FINGERPRINT, action: "create_issue", stage: "classification", issueNumber: 202, error: "field option retired" },
    ]);
    expect(result.aborted).toEqual({ stage: "classification", sourceFingerprint: APPEND_FINGERPRINT,
      reason: "repeated_fault", error: "field option retired" });
    expect(result.ledgerRecords.map((row) => row.durableState)).toEqual(["classification_failed", "classification_failed", "never_attempted"]);
    expect(result.ledgerRecords[2]).toHaveProperty("skippedDueToAbort", true);
    const rows = readJournal(value.journalPath).records as Record<string, unknown>[];
    expect(rows.map((row) => row.event)).toEqual(["intent", "created", "classification_failed", "intent", "created", "classification_failed"]);
    expect(rows.some((row) => row.sourceFingerprint === HOLD_FINGERPRINT)).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("records a recovery classification failure, completes a fresh approved create and exits 1", async () => {
    const value = creates(2);
    writeFileSync(value.journalPath, JSON.stringify(durableEvent("created", { issueNumber: 101, issueId: "I_101" })) + "\n");
    const transport = fakeTransport();
    vi.mocked(transport.applyClassification).mockRejectedValueOnce(new Error("recovery unavailable"));
    vi.mocked(transport.createIssue).mockResolvedValueOnce({ issueNumber: 202 });
    const result = await executeCli(value, { transport }).result;
    expect(result.failures).toEqual([{ sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue",
      stage: "recovery", issueNumber: 101, error: "recovery unavailable" }]);
    expect(transport.createIssue).toHaveBeenCalledExactlyOnceWith("example-org/example-repo", value.plan.entries[1].issue, expect.any(Function));
    expect(vi.mocked(transport.applyClassification).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(transport.createIssue).mock.invocationCallOrder[0]);
    expect(result.ledgerRecords.map((row) => row.durableState)).toEqual(["classification_failed", "complete"]);
    expect((readJournal(value.journalPath).records as Record<string, unknown>[]).map((row) => row.event))
      .toEqual(["created", "classification_failed", "intent", "created", "complete"]);
    expect(process.exitCode).toBe(1);
  });

  it("lists recovery and classification failures in execution order and completes the final create", async () => {
    const value = creates();
    writeFileSync(value.journalPath, JSON.stringify(durableEvent("classification_failed", { issueNumber: 101, issueId: "I_101" })) + "\n");
    const transport = fakeTransport();
    vi.mocked(transport.applyClassification).mockRejectedValueOnce(new Error("recovery failed"))
      .mockRejectedValueOnce(new Error("fresh classification failed"));
    vi.mocked(transport.createIssue).mockResolvedValueOnce({ issueNumber: 202 }).mockResolvedValueOnce({ issueNumber: 303 });
    const result = await executeCli(value, { transport }).result;
    expect(result.failures).toEqual([
      { sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue", stage: "recovery", issueNumber: 101, error: "recovery failed" },
      { sourceFingerprint: APPEND_FINGERPRINT, action: "create_issue", stage: "classification", issueNumber: 202, error: "fresh classification failed" },
    ]);
    expect(result.ledgerRecords.map((row) => row.durableState)).toEqual(["classification_failed", "classification_failed", "complete"]);
    expect(result).not.toHaveProperty("aborted");
    expect(transport.createIssue).toHaveBeenCalledTimes(2);
    expect(transport.createIssue).toHaveBeenNthCalledWith(1, "example-org/example-repo", value.plan.entries[1].issue, expect.any(Function));
    expect(transport.createIssue).toHaveBeenNthCalledWith(2, "example-org/example-repo", value.plan.entries[2].issue, expect.any(Function));
    for (const record of result.ledgerRecords) expect(record).not.toHaveProperty("skippedDueToAbort");
    const rows = readJournal(value.journalPath).records as Record<string, unknown>[];
    expect(rows.map((row) => row.event)).toEqual(["classification_failed", "classification_failed", "intent", "created", "classification_failed", "intent", "created", "complete"]);
    expect(rows.filter((row) => row.sourceFingerprint === HOLD_FINGERPRINT).map((row) => row.event)).toEqual(["intent", "created", "complete"]);
    expect(process.exitCode).toBe(1);
  });

  it("continues later recoveries after the first recovery fails", async () => {
    const value = creates(2);
    const rows = value.plan.entries.map((entry, index) => durableEvent("created", {
      sourceFingerprint: entry.sourceFingerprint, issueNumber: 101 + index,
      payload: { issue: entry.issue, evidenceComment: null, closeIssue: null },
    }));
    writeFileSync(value.journalPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const transport = fakeTransport();
    vi.mocked(transport.applyClassification).mockRejectedValueOnce(new Error("first recovery failed"));
    const result = await executeCli(value, { transport }).result;
    expect(result.failures).toHaveLength(1);
    expect(result.ledgerRecords.map((row) => row.durableState)).toEqual(["classification_failed", "complete"]);
    expect(transport.applyClassification).toHaveBeenCalledTimes(2);
    expect(transport.createIssue).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it.each(["append", "close"])("continues a fresh create after an evidence operation's %s failure", async (site) => {
    const source = addClose(report());
    source.candidates = [source.candidates[1], source.candidates[0]];
    const value = prepare(source, true);
    const transport = fakeTransport();
    if (site === "append") vi.mocked(transport.appendEvidenceComment).mockRejectedValueOnce(new Error("append unavailable"));
    else vi.mocked(transport.closeIssue).mockRejectedValueOnce(new Error("close unavailable"));
    const result = await executeCli(value, { transport, actionQualificationContext: LEGACY_CLOSE_QUALIFICATION }).result;
    expect(result.failures).toEqual([{ sourceFingerprint: APPEND_FINGERPRINT, action: "append_evidence",
      stage: "dispatch", issueNumber: 42, error: `${site} unavailable` }]);
    expect(result.ledgerRecords.map((row) => row.durableState)).toEqual(["unresolved_partial", "complete"]);
    expect(result.ledgerRecords[0].result.commentId).toBe(site === "append" ? null : "IC_202");
    expect(transport.createIssue).toHaveBeenCalledExactlyOnceWith("example-org/example-repo", value.plan.entries[1].issue, expect.any(Function));
    expect(transport.closeIssue).toHaveBeenCalledTimes(site === "append" ? 0 : 1);
    expect(readJournal(value.journalPath).records[1]).toMatchObject({ event: "create_unresolved", error: `${site} unavailable` });
    expect(process.exitCode).toBe(1);
  });

  it("continues after an invalid issue number and retains the landed issue ID", async () => {
    const value = creates(2);
    const transport = fakeTransport();
    vi.mocked(transport.createIssue).mockResolvedValueOnce({ issueNumber: 0, issueId: "I_invalid" });
    const result = await executeCli(value, { transport }).result;
    expect(result.failures).toEqual([{ sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue",
      stage: "dispatch", issueNumber: null, error: "Dispatched operation returned no valid issue number." }]);
    expect(result.ledgerRecords.map((row) => row.durableState)).toEqual(["unresolved_partial", "complete"]);
    expect(result.ledgerRecords[0].result).toEqual({ issueNumber: null, issueId: "I_invalid", commentId: null });
    expect(transport.createIssue).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBe(1);
  });

  it.each(["mismatch", "unavailable"])("continues a fresh create after classification read-back is %s", async (site) => {
    const value = creates(2);
    const transport = fakeTransport();
    if (site === "mismatch") vi.mocked(transport.verifyClassifications).mockResolvedValueOnce(false);
    else vi.mocked(transport.verifyClassifications).mockRejectedValueOnce(new Error("service unavailable"));
    const result = await executeCli(value, { transport }).result;
    expect(result.failures).toEqual([{ sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue",
      stage: "classification", issueNumber: 101, error: site === "mismatch"
        ? "Classification read-back mismatched the requested values."
        : "Classification read-back unavailable: service unavailable" }]);
    expect(result.ledgerRecords.map((row) => row.durableState)).toEqual(["classification_failed", "complete"]);
    expect(transport.createIssue).toHaveBeenCalledTimes(2);
    expect(readJournal(value.journalPath).records[2]).toMatchObject({ event: "classification_failed", error: result.failures[0].error });
    expect(process.exitCode).toBe(1);
  });

  it.each(["intent", "created", "classification_failed", "create_unresolved"])(
    "aborts on the second operation's %s fsync failure and never touches the third", async (event) => {
      const value = creates();
      const transport = fakeTransport();
      if (event === "classification_failed") vi.mocked(transport.applyClassification).mockImplementation(async (_repository, issueNumber) => {
        if (issueNumber === 202) throw new Error("classification unavailable");
        return {};
      });
      vi.mocked(transport.createIssue).mockResolvedValueOnce({ issueNumber: 101 });
      if (event === "create_unresolved") vi.mocked(transport.createIssue).mockRejectedValueOnce(new Error("create unavailable"));
      else vi.mocked(transport.createIssue).mockResolvedValueOnce({ issueNumber: 202 });
      const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
      vi.mocked(fsyncSync).mockImplementation((fd) => {
        const last = readJournal(value.journalPath).records.at(-1) as Record<string, unknown> | undefined;
        if (last?.sourceFingerprint === APPEND_FINGERPRINT && last.event === event) throw new Error("disk failed");
        fs.fsyncSync(fd);
      });
      await expect(executeCli(value, { transport }).result).rejects.toThrow(JournalWriteError);
      expect(transport.createIssue).toHaveBeenCalledTimes(event === "intent" ? 1 : 2);
      expect((readJournal(value.journalPath).records as Record<string, unknown>[]).some((row) => row.sourceFingerprint === HOLD_FINGERPRINT)).toBe(false);
      expect(readJournal(value.journalPath).records.at(-1)).toMatchObject({ sourceFingerprint: APPEND_FINGERPRINT, event });
    },
  );
});

function addClose(reportValue: ReturnType<typeof report>) {
  const decision = reportValue.decision.candidates.find((candidate) =>
    candidate.sourceFingerprint === APPEND_FINGERPRINT)! as unknown as { actions: Array<Record<string, unknown>> };
  decision.actions = [{
    action: "append_evidence", targetIssueNumber: 42, before: "existing_evidence",
    proposed: "evidence-sha", evidenceIds: ["append-proof"], confidence: "high", rationale: "Append proof.",
  }, {
    action: "close_issue", targetIssueNumber: 42, before: "OPEN", proposed: "CLOSED",
    evidenceIds: ["merged:abc123"], confidence: "high", rationale: "Merged work proves completion.",
  }];
  const candidate = reportValue.candidates.find((entry) =>
    entry.sourceFingerprint === APPEND_FINGERPRINT)! as unknown as {
      draft: {
        intendedActions: ("create_issue" | "append_evidence" | "close_issue")[];
        closeIssue: null | { targetIssueNumber: number; before: "OPEN"; after: "CLOSED"; evidenceIds: string[] };
      };
    };
  candidate.draft!.intendedActions = ["append_evidence", "close_issue"];
  candidate.draft!.closeIssue = {
    targetIssueNumber: 42, before: "OPEN", after: "CLOSED", evidenceIds: ["merged:abc123"],
  };
  return reportValue;
}

describe("operator roadmap intake approval and apply", () => {
  it("preflight names every invalid Priority entry and attempts zero mutations", async () => {
    const value = fixture();
    const source = report();
    source.candidates[1].draft!.deniedClassification = [{
      action: "set_priority", fieldName: "Priority", value: "P2", disposition: "recommendation_only",
      rationale: "The evidence establishes material impact.", confidence: "medium", deniedReason: "Approval required.",
    }];
    value.decisionContent = `${JSON.stringify(source, null, 2)}\n`;
    writeFileSync(value.decisionPath, value.decisionContent, "utf8");
    const plan = buildIntakeApprovalPlan({ decisionPath: value.decisionPath, decisionContent: value.decisionContent, now: NOW });
    const create = plan.entries.find((entry) => entry.sourceFingerprint === CREATE_FINGERPRINT)!;
    const append = plan.entries.find((entry) => entry.sourceFingerprint === APPEND_FINGERPRINT)!;
    create.approved = true;
    append.approved = true;
    create.deniedClassification.find((entry) => entry.fieldName === "Priority")!.value = "P9";
    append.deniedClassification.find((entry) => entry.fieldName === "Priority")!.value = "P8";
    writeFileSync(value.planPath, JSON.stringify(plan), "utf8");
    writeRunEvidenceFixture(value.planPath, EVIDENCE_CENSUS, true);
    const requests: { readonly input: string; readonly method: string }[] = [];
    const transport = createGitHubIntakeApprovalTransport({ token: "operator-token", fetchImpl: async (input, init) => {
      requests.push({ input: String(input), method: init?.method ?? "GET" });
      if (String(input).includes("/issue-types")) {
        return new Response(JSON.stringify({ issue_types: [{ name: "Task" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ issue_fields: [{
        id: 91, name: "Priority", options: [{ name: "P1" }, { name: "P2" }],
      }, { id: 92, name: "Effort", options: [{ name: "Medium" }] }] }), { status: 200 });
    } });

    const result = applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true,
      trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, transport, now: NOW,
    });

    await expect(result).rejects.toThrow(new RegExp(`${CREATE_FINGERPRINT}[^\\n]+Priority=P9[\\s\\S]+${APPEND_FINGERPRINT}[^\\n]+Priority=P8`));
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
    expect(requests.some(({ input }) => /\/issues(?:\/|$)/.test(new URL(input).pathname))).toBe(false);
    expect(existsSync(value.journalPath)).toBe(false);
  });

  it("preflight refuses an invalid Type against live organization issue types with zero mutations", async () => {
    const value = fixture();
    const create = value.plan.entries.find((entry) => entry.sourceFingerprint === CREATE_FINGERPRINT)!;
    create.approved = true;
    create.deniedClassification.find((entry) => entry.fieldName === "Type")!.value = "Imaginary";
    value.persistPlan();
    const requests: { readonly input: string; readonly method: string }[] = [];
    const transport = createGitHubIntakeApprovalTransport({ token: "operator-token", fetchImpl: async (input, init) => {
      requests.push({ input: String(input), method: init?.method ?? "GET" });
      if (String(input).includes("/issue-types")) {
        return new Response(JSON.stringify({ issue_types: [{ name: "Task" }, { name: "Bug" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ issue_fields: [{
        id: 91, name: "Priority", options: [{ name: "P2" }],
      }, { id: 92, name: "Effort", options: [{ name: "Medium" }] }] }), { status: 200 });
    } });

    await expect(applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true,
      trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, transport, now: NOW,
    })).rejects.toThrow(`${CREATE_FINGERPRINT}: Type=Imaginary is not a live issue type. Live types: Task, Bug.`);
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
    expect(existsSync(value.journalPath)).toBe(false);
  });

  it("preflights a valid plan once per organization resource and then writes", async () => {
    const value = fixture();
    value.plan.entries.find((entry) => entry.sourceFingerprint === CREATE_FINGERPRINT)!.approved = true;
    value.persistPlan();
    const requests: { readonly input: string; readonly method: string }[] = [];
    const transport = createGitHubIntakeApprovalTransport({ token: "operator-token", fetchImpl: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ input: url, method });
      if (url.includes("/issue-types")) {
        return new Response(JSON.stringify({ issue_types: [{ name: "Task" }] }), { status: 200 });
      }
      if (url.includes("/issue-fields?")) {
        return new Response(JSON.stringify({ issue_fields: [{
          id: 91, name: "Priority", options: [{ name: "P2" }],
        }, { id: 92, name: "Effort", options: [{ name: "Medium" }] }] }), { status: 200 });
      }
      if (method === "POST" && url.endsWith("/issues")) {
        return new Response(JSON.stringify({ number: 101, node_id: "I_101" }), { status: 201 });
      }
      if (method === "GET" && url.endsWith("/issues/101")) {
        return new Response(JSON.stringify({ type: { name: "Task" } }), { status: 200 });
      }
      if (method === "GET" && url.includes("/issues/101/issue-field-values?")) {
        return new Response(JSON.stringify([
          { issue_field_id: 91, single_select_option: { id: "P2", name: "P2" } },
          { issue_field_id: 92, single_select_option: { id: "Medium", name: "Medium" } },
        ]), { status: 200 });
      }
      return new Response("", { status: 200 });
    } });

    await applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true,
      trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, transport, now: NOW,
    });

    expect(requests.filter(({ input }) => input.includes("/issue-fields?"))).toHaveLength(1);
    expect(requests.filter(({ input }) => input.includes("/issue-types"))).toHaveLength(1);
    // Both definition reads are paged explicitly: an org that outgrew the default page would
    // otherwise truncate the live vocabulary and refuse a plan the write path would accept.
    expect(requests.find(({ input }) => input.includes("/issue-types"))?.input)
      .toBe("https://api.github.com/orgs/example-org/issue-types?per_page=100");
    // GraphQL is POST-shaped but read-only (the receipt snapshots); count only REST writes.
    expect(requests.filter(({ input, method }) => (method === "POST" || method === "PATCH") && !input.endsWith("/graphql"))).toHaveLength(4);
    expect(requests.filter(({ input }) => input.endsWith("/graphql")).length).toBeGreaterThan(0);
  });

  it("serializes field writes with field_id and caches live field definitions across entries", async () => {
    const requests: { readonly input: string; readonly init?: RequestInit }[] = [];
    const fetchImpl = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      requests.push({ input: String(input), init });
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ issue_fields: [{
          id: 91, name: "Priority", options: [{ id: 1, name: "P1" }, { id: 2, name: "P2" }],
        }, {
          id: 92, name: "Effort", options: [{ id: 3, name: "Medium" }, { id: 4, name: "Large" }],
        }] }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };
    const transport = createGitHubIntakeApprovalTransport({ token: "operator-token", fetchImpl });

    await transport.applyClassification("example-org/example-repo", 101, { fieldName: "Priority", value: "P1" });
    await transport.applyClassification("example-org/example-repo", 102, { fieldName: "Effort", value: "Medium" });

    expect(requests.filter((request) => request.init?.method === "GET")).toHaveLength(1);
    expect(requests[0].input).toBe("https://api.github.com/orgs/example-org/issue-fields?per_page=100");
    expect(String(requests[1].init?.body)).toBe(
      '{"issue_field_values":[{"field_id":91,"value":"P1"}]}',
    );
    expect(String(requests[2].init?.body)).toBe(
      '{"issue_field_values":[{"field_id":92,"value":"Medium"}]}',
    );
  });

  it("writes Type through the native issue PATCH without reading issue fields", async () => {
    const requests: { readonly input: string; readonly init?: RequestInit }[] = [];
    const fetchImpl = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      requests.push({ input: String(input), init });
      return new Response(JSON.stringify({ node_id: "I_101" }), { status: 200 });
    };
    const transport = createGitHubIntakeApprovalTransport({ token: "operator-token", fetchImpl });

    await transport.applyClassification("example-org/example-repo", 101, { fieldName: "Type", value: "Task" });

    expect(requests).toHaveLength(1);
    expect(requests[0].input).toBe("https://api.github.com/repos/example-org/example-repo/issues/101");
    expect(requests[0].init?.method).toBe("PATCH");
    expect(String(requests[0].init?.body)).toBe('{"type":"Task"}');
  });

  it("refuses a non-live field option locally without an HTTP write", async () => {
    const methods: string[] = [];
    const fetchImpl = async (_input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
      methods.push(init?.method ?? "GET");
      return new Response(JSON.stringify({ issue_fields: [{
        id: 91, name: "Priority", options: [{ id: 1, name: "P1" }, { id: 2, name: "P2" }],
      }] }), { status: 200 });
    };
    const transport = createGitHubIntakeApprovalTransport({ token: "operator-token", fetchImpl });

    await expect(transport.applyClassification("example-org/example-repo", 101, {
      fieldName: "Priority", value: "P9",
    })).rejects.toThrow("P9 is not a live option for Priority. Live options: P1, P2.");
    expect(methods).toEqual(["GET"]);
  });

  it("refuses Horizon at the concrete write transport before any HTTP request", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const transport = createGitHubIntakeApprovalTransport({ token: "operator-token", fetchImpl });

    await expect(transport.applyClassification("example-org/example-repo", 101, {
      fieldName: "Horizon", value: "Later",
    } as never)).rejects.toThrow(/structurally forbids writing a Horizon classification/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("executes a pretty-printed candidate through a compiler-produced decision report", async () => {
    const root = mkdtempSync(join(tmpdir(), "roadmap-intake-compiler-contract-"));
    const inputs = join(root, "inputs");
    const artifacts = join(root, "artifacts", "github-issue-roadmap");
    mkdirSync(inputs, { recursive: true });
    mkdirSync(artifacts, { recursive: true });
    const stack = buildIntakeStack({ capabilities: ["create_issue"] });
    const write = (name: string, value: unknown) => {
      const path = join(inputs, name);
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      return path;
    };
    const candidatePath = write("candidate.json", stack.envelope);
    const existencePath = write("existence.json", stack.existenceRecord);
    const shadow = runIntakeShadow({
      dispositionHistory: emptyDispositionHistory,
      candidate: candidatePath,
      snapshot: write("snapshot.json", stack.snapshot),
      assessment: write("assessment.json", stack.assessment),
      existence: existencePath,
      verifiedOriginMainSha: STACK_ORIGIN_MAIN_SHA,
      capabilities: write("capabilities.json", stack.capabilityManifest),
      out: join(artifacts, "decision.json"), repoRoot: root,
      now: new Date(Date.parse(stack.snapshot.generatedAt) + 60_000), log: () => undefined,
    });
    const decisionContent = readFileSync(shadow.outputPath, "utf8");
    const planPath = join(artifacts, "approval.json");
    const plan = buildIntakeApprovalPlan({ decisionPath: shadow.outputPath, decisionContent, now: NOW });
    plan.entries.find((entry) => entry.intendedAction === "create_issue")!.approved = true;
    writeFileSync(planPath, JSON.stringify(plan), "utf8");
    const named = (path: string) => ({ path: basename(path), bytes: readFileSync(path) });
    for (const name of ["candidate.json", "snapshot.json", "assessment.json"]) {
      writeFileSync(join(artifacts, name), readFileSync(join(inputs, name)));
    }
    const built = buildRunEvidence({ runId: "compiler-run", repository: "example-org/example-repo", preparedAt: NOW.toISOString(),
      approvalPlan: named(planPath), census: named(join(artifacts, "snapshot.json")), decisions: [{
        decision: named(shadow.outputPath), candidate: named(join(artifacts, "candidate.json")),
        snapshot: named(join(artifacts, "snapshot.json")), assessment: named(join(artifacts, "assessment.json")),
      }] });
    if (!built.ok) throw new Error(built.reason);
    const runEvidencePath = join(artifacts, "run-evidence.json");
    writeFileSync(runEvidencePath, JSON.stringify(built.evidence));
    const transport = fakeTransport();

    await applyIntakeApprovalPlan({
      planPath, runEvidencePath, execute: true, trustedCurrentOriginMainSha: STACK_ORIGIN_MAIN_SHA,
      candidatePaths: [candidatePath], existencePaths: [existencePath], repoRoot: root,
      runGit: fakeGit, dispositionHistory: emptyDispositionHistory, transport, now: NOW,
    });

    expect(transport.createIssue).toHaveBeenCalledTimes(1);
    expect(stack.decision.candidateSha256).toBe(canonicalJsonSha256(parseOutcomeEnvelope(JSON.parse(readFileSync(candidatePath, "utf8")))));
  });

  it("executes after SHA advancement with equal verdicts and records both SHAs and revalidation", async () => {
    const value = fixture();
    value.plan.entries[0].approved = true;
    value.persistPlan();
    const call = executeCli(value);
    const result = await call.result;
    expect(call.transport.createIssue).toHaveBeenCalledTimes(1);
    expect(call.runGit).toHaveBeenCalledWith(value.root, ["rev-parse", "--verify", `${ADVANCED_SHA}^{commit}`]);
    expect(call.runGit).toHaveBeenCalledWith(value.root, ["ls-tree", "-r", "--name-only", ADVANCED_SHA]);
    for (const record of result.ledgerRecords) {
      expect(record.existenceRevalidation).toEqual({
        boundOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, trustedOriginMainSha: ADVANCED_SHA, verdictEqualityVerified: true,
      });
    }
    expect(result.ledgerRecords).toHaveLength(value.plan.entries.length);
    expect(readFileSync(value.journalPath, "utf8").trim().split("\n").length).toBeGreaterThan(result.ledgerRecords.length);
  });

  it("refuses an advanced SHA with a changed state naming fingerprint and both states before transport or writes", async () => {
    const value = fixture();
    const envelope = createOutcomeEnvelope({
      schemaVersion: ENVELOPE.schemaVersion,
      repository: ENVELOPE.repository, producer: ENVELOPE.producer, artifact: ENVELOPE.artifact,
      candidates: ENVELOPE.candidates.map(({ sourceFingerprint: _source, emissionContentSha256: _emission, ...candidate }) => ({
        ...candidate,
        outcome: candidate.stableOutcomeId === "create"
          ? { ...candidate.outcome, completionRule: "The repository exports `ready`." }
          : candidate.outcome,
      })),
    });
    expect(envelope.candidates.find((candidate) => candidate.stableOutcomeId === "create")!.sourceFingerprint).toBe(CREATE_FINGERPRINT);
    const existence = probeExistenceAtSha({
      dispositionHistory: emptyDispositionHistory,
      envelope, originMainSha: VERIFIED_ORIGIN_MAIN_SHA, repoRoot: value.root,
      runGit: (cwd, args) => args[0] === "grep" ? "" : fakeGit(cwd, args),
      budget: Number.MAX_SAFE_INTEGER, generatedAt: NOW.toISOString(),
    });
    writeFileSync(value.candidatePath, JSON.stringify(envelope), "utf8");
    writeFileSync(value.existencePath, JSON.stringify(existence), "utf8");
    const source = report();
    const snapshot = reboundSnapshot(EVIDENCE_CENSUS, envelope);
    source.decision.candidateSha256 = canonicalJsonSha256(envelope);
    source.decision.snapshotContentSha256 = snapshot.contentSha256;
    source.decision.assessmentSha256 = canonicalJsonSha256(evidenceAssessment(envelope, snapshot));
    source.decision.existenceRecordContentSha256 = existence.contentSha256;
    const decisionContent = JSON.stringify(source);
    writeFileSync(value.decisionPath, decisionContent, "utf8");
    const plan = buildIntakeApprovalPlan({ decisionPath: value.decisionPath, decisionContent, now: NOW });
    plan.entries[0].approved = true;
    writeFileSync(value.planPath, JSON.stringify(plan), "utf8");
    writeRunEvidenceFixture(value.planPath, EVIDENCE_CENSUS);
    const call = executeCli(value, { runGit: (cwd, args) => {
      if (args[0] === "ls-tree") return "src/create.ts";
      if (args[0] === "grep") return `${ADVANCED_SHA}:src/create.ts:1:export const ready = true;`;
      if (args[0] === "show") return "export const ready = true;";
      if (args[0] === "log") return ADVANCED_SHA;
      return fakeGit(cwd, args);
    } });
    await expect(call.result).rejects.toThrow(`Existence verdict changed for ${CREATE_FINGERPRINT}: bound not_demonstrated, fresh demonstrated.`);
    expect(call.openTransport).not.toHaveBeenCalled();
    expect(existsSync(value.journalPath)).toBe(false);
  });

  it("refuses a fresh run outcome even when the bound record carries the same outcome", async () => {
    const value = fixture();
    const degraded = createExistenceRecord({
      repository: ENVELOPE.repository, originMainSha: VERIFIED_ORIGIN_MAIN_SHA, generatedAt: NOW.toISOString(),
      entries: ENVELOPE.candidates.map((candidate) => ({ sourceFingerprint: candidate.sourceFingerprint,
        emissionContentSha256: candidate.emissionContentSha256, runOutcome: { kind: "read_failure" } })),
    });
    writeFileSync(value.existencePath, JSON.stringify(degraded), "utf8");
    const source = report();
    source.decision.existenceRecordContentSha256 = degraded.contentSha256;
    const content = JSON.stringify(source);
    writeFileSync(value.decisionPath, content, "utf8");
    const plan = buildIntakeApprovalPlan({ decisionPath: value.decisionPath, decisionContent: content, now: NOW });
    plan.entries[0].approved = true;
    writeFileSync(value.planPath, JSON.stringify(plan), "utf8");
    writeRunEvidenceFixture(value.planPath, EVIDENCE_CENSUS, true);
    const call = executeCli(value, { runGit: (cwd, args) => {
      if (args[0] === "ls-tree") throw new Error("read unavailable");
      return fakeGit(cwd, args);
    } });
    await expect(call.result).rejects.toThrow(`Existence revalidation refused ${degraded.entries[0].sourceFingerprint}: fresh read_failure.`);
    expect(call.openTransport).not.toHaveBeenCalled();
    expect(existsSync(value.journalPath)).toBe(false);
  });

  it.each(["unresolvable", "different resolution", "malformed"])("refuses a trusted SHA that is %s before probing", async (kind) => {
    const value = fixture();
    const call = executeCli(value, { sha: kind === "malformed" ? "invalid" : ADVANCED_SHA, runGit: () => {
      if (kind === "unresolvable") throw new Error("unknown commit");
      return VERIFIED_ORIGIN_MAIN_SHA;
    } });
    await expect(call.result).rejects.toThrow(kind === "malformed" ? /requires --origin-main-sha/ : /not a local commit/);
    expect(call.runGit.mock.calls.every(([, args]) => args[0] === "rev-parse")).toBe(true);
    expect(call.openTransport).not.toHaveBeenCalled();
    expect(existsSync(value.journalPath)).toBe(false);
  });

  it.each(["candidate", "existence"])("refuses missing --%s naming the unmatched decision report", async (flag) => {
    const value = fixture();
    const call = executeCli(value, { flags: flag === "candidate" ? [`--existence=${value.existencePath}`] : [`--candidate=${value.candidatePath}`] });
    await expect(call.result).rejects.toThrow(`No --${flag} supplied for decision report ${value.decisionPath}.`);
    expect(call.openTransport).not.toHaveBeenCalled();
    expect(call.runGit.mock.calls).toHaveLength(1);
    expect(existsSync(value.journalPath)).toBe(false);
  });

  it.each(["candidate", "existence"])("refuses an extra --%s matching no decision report", async (flag) => {
    const value = fixture();
    const extra = join(value.root, "extra.json");
    writeFileSync(extra, flag === "candidate" ? JSON.stringify(distinctEnvelope()) : JSON.stringify(createExistenceRecord({
      repository: BOUND_EXISTENCE.repository, originMainSha: ADVANCED_SHA,
      generatedAt: NOW.toISOString(), entries: BOUND_EXISTENCE.entries,
    })), "utf8");
    const call = executeCli(value, { flags: [`--candidate=${value.candidatePath}`, `--existence=${value.existencePath}`, `--${flag}=${extra}`] });
    await expect(call.result).rejects.toThrow(`Supplied --${flag} matches no decision report: ${extra}.`);
    expect(call.openTransport).not.toHaveBeenCalled();
    expect(call.runGit.mock.calls).toHaveLength(1);
    expect(existsSync(value.journalPath)).toBe(false);
  });

  it("refuses a supplied candidate whose canonical envelope hash does not match the binding", async () => {
    const value = fixture();
    writeFileSync(value.candidatePath, JSON.stringify(distinctEnvelope()), "utf8");
    const call = executeCli(value);
    await expect(call.result).rejects.toThrow(`Supplied --candidate does not match candidateSha256 for decision report ${value.decisionPath}.`);
    expect(call.openTransport).not.toHaveBeenCalled();
    expect(existsSync(value.journalPath)).toBe(false);
  });

  it("refuses a supplied existence record whose content hash does not match the binding", async () => {
    const value = fixture();
    const wrongRecord = createExistenceRecord({
      repository: BOUND_EXISTENCE.repository, originMainSha: ADVANCED_SHA,
      generatedAt: NOW.toISOString(), entries: BOUND_EXISTENCE.entries,
    });
    writeFileSync(value.existencePath, JSON.stringify(wrongRecord), "utf8");
    const call = executeCli(value);
    await expect(call.result).rejects.toThrow(
      `Supplied --existence does not match existenceRecordContentSha256 for decision report ${value.decisionPath}.`,
    );
    expect(call.openTransport).not.toHaveBeenCalled();
    expect(existsSync(value.journalPath)).toBe(false);
  });

  it.each(["candidate", "existence"])("refuses an invalid supplied --%s rather than skipping it", async (flag) => {
    const value = fixture();
    writeFileSync(flag === "candidate" ? value.candidatePath : value.existencePath, "{}", "utf8");
    const call = executeCli(value);
    await expect(call.result).rejects.toThrow();
    expect(call.openTransport).not.toHaveBeenCalled();
    expect(call.runGit.mock.calls).toHaveLength(1);
    expect(existsSync(value.journalPath)).toBe(false);
  });

  it.each(["candidate", "existence"])("refuses --%s without --execute", async (flag) => {
    const value = fixture();
    await expect(runIntakeApplyCli({ argv: [`--plan=${value.planPath}`, `--${flag}=unused.json`] }))
      .rejects.toThrow(`--${flag} is supported only with --execute.`);
  });

  it("keeps dry-run credential-free with no probe when the current SHA has advanced", async () => {
    const value = fixture();
    value.plan.entries[0].approved = true;
    value.persistPlan();
    const runGit = vi.fn(() => ADVANCED_SHA);
    const openTransport = vi.fn(() => fakeTransport());
    const result = await runIntakeApplyCli({ argv: [`--plan=${value.planPath}`],
      runGit, openTransport, log: () => undefined });
    expect(result.mode).toBe("dry-run");
    expect(result.writes).toHaveLength(1);
    expect(result.ledgerRecords.every((record) => record.existenceRevalidation === undefined)).toBe(true);
    expect(runGit).not.toHaveBeenCalled();
    expect(openTransport).not.toHaveBeenCalled();
  });

  it("files different candidates bound to different canonical hashes and revalidates each distinct input", async () => {
    const value = fixture();
    const secondCandidate = join(value.root, "candidate-two.json");
    const secondExistence = join(value.root, "existence-two.json");
    const secondDecision = join(value.root, "decision-two.json");
    const secondEnvelope = createOutcomeEnvelope({
      schemaVersion: "github-issue-roadmap-outcome-envelope/v1",
      repository: ENVELOPE.repository, producer: ENVELOPE.producer,
      artifact: { ...ENVELOPE.artifact, stableId: "example-two" },
      candidates: ENVELOPE.candidates.map(({ sourceFingerprint: _source, emissionContentSha256: _emission, ...candidate }) => ({
        ...candidate, stableOutcomeId: `${candidate.stableOutcomeId}-two`,
      })),
    });
    const secondBytes = `${JSON.stringify(secondEnvelope, null, 2)}\n`;
    const secondRecord = probeExistenceAtSha({ dispositionHistory: emptyDispositionHistory, envelope: secondEnvelope, originMainSha: "1".repeat(40),
      repoRoot: value.root, runGit: fakeGit, budget: Number.MAX_SAFE_INTEGER, generatedAt: NOW.toISOString() });
    writeFileSync(secondCandidate, secondBytes, "utf8");
    writeFileSync(secondExistence, JSON.stringify(secondRecord), "utf8");
    const source = report();
    const fingerprints = new Map(ENVELOPE.candidates.map((candidate, index) =>
      [candidate.sourceFingerprint, secondEnvelope.candidates[index].sourceFingerprint]));
    source.decision.candidateSha256 = canonicalJsonSha256(secondEnvelope);
    const snapshot = reboundSnapshot(EVIDENCE_CENSUS, secondEnvelope);
    source.decision.snapshotContentSha256 = snapshot.contentSha256;
    source.decision.assessmentSha256 = canonicalJsonSha256(evidenceAssessment(secondEnvelope, snapshot));
    source.decision.existenceRecordContentSha256 = secondRecord.contentSha256;
    source.decision.verifiedOriginMainSha = secondRecord.originMainSha;
    source.decision.candidates.forEach((candidate) => { candidate.sourceFingerprint = fingerprints.get(candidate.sourceFingerprint)!; });
    source.candidates.forEach((candidate) => {
      candidate.sourceFingerprint = fingerprints.get(candidate.sourceFingerprint)!;
      if (candidate.draft !== null) candidate.draft = draft(candidate.sourceFingerprint, candidate.draft.intendedAction, candidate.draft.canonicalIssueNumber);
    });
    writeFileSync(secondDecision, JSON.stringify(source), "utf8");
    const plan = runIntakeApproveCli({ argv: [`--decision=${value.decisionPath}`, `--decision=${secondDecision}`, `--out=${value.planPath}`], now: NOW });
    plan.entries.filter((entry) => entry.intendedAction === "create_issue").forEach((entry) => { entry.approved = true; });
    writeFileSync(value.planPath, JSON.stringify(plan), "utf8");
    writeRunEvidenceFixture(value.planPath, EVIDENCE_CENSUS, true);
    const missing = executeCli(value);
    await expect(missing.result).rejects.toThrow(`Supplied --candidate does not match candidateSha256 for decision report ${secondDecision}.`);
    expect(missing.openTransport).not.toHaveBeenCalled();
    expect(existsSync(value.journalPath)).toBe(false);
    const call = executeCli(value, { flags: [`--existence=${secondExistence}`, `--candidate=${secondCandidate}`,
      `--existence=${value.existencePath}`, `--candidate=${value.candidatePath}`] });
    const result = await call.result;
    expect(call.transport.createIssue).toHaveBeenCalledTimes(2);
    expect(call.runGit.mock.calls.filter(([, args]) => args[0] === "ls-tree")).toHaveLength(2);
    expect(result.ledgerRecords.map((record) => record.existenceRevalidation?.boundOriginMainSha))
      .toEqual([VERIFIED_ORIGIN_MAIN_SHA, VERIFIED_ORIGIN_MAIN_SHA, VERIFIED_ORIGIN_MAIN_SHA,
        secondRecord.originMainSha, secondRecord.originMainSha, secondRecord.originMainSha]);
  });

  it("refuses the same approved fingerprint from two decision reports before probing or opening transport", async () => {
    const value = fixture();
    const secondCandidate = join(value.root, "candidate-two.json");
    const secondDecision = join(value.root, "decision-two.json");
    const secondEnvelope = createOutcomeEnvelope({
      schemaVersion: "github-issue-roadmap-outcome-envelope/v1",
      repository: ENVELOPE.repository, producer: ENVELOPE.producer, artifact: ENVELOPE.artifact,
      candidates: ENVELOPE.candidates.map(({ sourceFingerprint: _source, emissionContentSha256: _emission, ...candidate }) => ({
        ...candidate, outcome: { ...candidate.outcome, title: `${candidate.outcome.title} revised` },
      })),
    });
    writeFileSync(secondCandidate, JSON.stringify(secondEnvelope, null, 2), "utf8");
    const source = report();
    source.decision.candidateSha256 = canonicalJsonSha256(secondEnvelope);
    const snapshot = reboundSnapshot(EVIDENCE_CENSUS, secondEnvelope);
    source.decision.snapshotContentSha256 = snapshot.contentSha256;
    source.decision.assessmentSha256 = canonicalJsonSha256(evidenceAssessment(secondEnvelope, snapshot));
    writeFileSync(secondDecision, JSON.stringify(source), "utf8");
    const plan = runIntakeApproveCli({
      argv: [`--decision=${value.decisionPath}`, `--decision=${secondDecision}`, `--out=${value.planPath}`], now: NOW,
    });
    plan.entries.filter((entry) => entry.sourceFingerprint === CREATE_FINGERPRINT)
      .forEach((entry) => { entry.approved = true; });
    writeFileSync(value.planPath, JSON.stringify(plan), "utf8");
    writeRunEvidenceFixture(value.planPath, EVIDENCE_CENSUS, true);
    const call = executeCli(value, { flags: [`--candidate=${value.candidatePath}`, `--candidate=${secondCandidate}`,
      `--existence=${value.existencePath}`] });
    await expect(call.result).rejects.toThrow(
      `Approved write ${CREATE_FINGERPRINT} appears in multiple decision reports: ${value.decisionPath} and ${secondDecision}.`,
    );
    expect(call.runGit).not.toHaveBeenCalled();
    expect(call.openTransport).not.toHaveBeenCalled();
    expect(existsSync(value.journalPath)).toBe(false);
  });

  it("probes one canonical candidate and trusted SHA only once across decision reports", async () => {
    const value = fixture();
    const secondDecision = join(value.root, "decision-two.json");
    writeFileSync(secondDecision, JSON.stringify(report()), "utf8");
    const plan = runIntakeApproveCli({
      argv: [`--decision=${value.decisionPath}`, `--decision=${secondDecision}`, `--out=${value.planPath}`], now: NOW,
    });
    writeFileSync(value.planPath, JSON.stringify(plan), "utf8");
    writeRunEvidenceFixture(value.planPath, EVIDENCE_CENSUS, true);
    const call = executeCli(value);

    await call.result;

    expect(call.runGit.mock.calls.filter(([, args]) => args[0] === "ls-tree")).toHaveLength(1);
    expect(call.openTransport).not.toHaveBeenCalled();
  });

  it.each(["candidate set", "duplicate", "unapproved", "binding"])("preserves execute refusal for changed %s", async (kind) => {
    const value = fixture();
    let expected: RegExp;
    if (kind === "candidate set") {
      value.plan.entries.pop();
      expected = /changed the source candidate set/;
    } else if (kind === "duplicate") {
      value.plan.entries[1] = value.plan.entries[0];
      expected = /duplicates/;
    } else if (kind === "unapproved") {
      (value.plan.entries[0] as unknown as { approved: unknown }).approved = "yes";
      expected = /approved must be boolean/;
    } else {
      (value.plan.decisions[0] as { verifiedOriginMainSha: string }).verifiedOriginMainSha = ADVANCED_SHA;
      expected = /existence binding differs/;
    }
    value.persistPlan();
    const call = executeCli(value);
    await expect(call.result).rejects.toThrow(expected);
    expect(call.runGit).not.toHaveBeenCalled();
    expect(call.openTransport).not.toHaveBeenCalled();
    expect(existsSync(value.journalPath)).toBe(false);
  });

  it("refuses an approved legacy close before opening or calling any transport", async () => {
    const value = fixture();
    const decisionContent = JSON.stringify(addClose(report()));
    writeFileSync(value.decisionPath, decisionContent);
    const plan = buildIntakeApprovalPlan({ decisionPath: value.decisionPath, decisionContent, now: NOW });
    const entry = plan.entries.find(entry => entry.sourceFingerprint === APPEND_FINGERPRINT)!;
    entry.approved = true;
    expect(entry.intendedActions).toContain("close_issue");
    writeFileSync(value.planPath, JSON.stringify(plan));
    writeRunEvidenceFixture(value.planPath, EVIDENCE_CENSUS, true);
    const call = executeCli(value);
    await expect(call.result).rejects.toThrow("Capability close_issue is disabled or unqualified.");
    expect(call.openTransport).not.toHaveBeenCalled();
    for (const method of Object.values(call.transport)) if (typeof method === "function") expect(method).not.toHaveBeenCalled();
    expect(existsSync(value.journalPath)).toBe(false);
  });

  it("executes close only after its evidence append succeeds", async () => {
    const value = fixture();
    value.decisionContent = `${JSON.stringify(addClose(report()), null, 2)}\n`;
    writeFileSync(value.decisionPath, value.decisionContent, "utf8");
    const closePlan = buildIntakeApprovalPlan({
      decisionPath: value.decisionPath, decisionContent: value.decisionContent, now: NOW,
    });
    closePlan.entries.find((entry) => entry.sourceFingerprint === APPEND_FINGERPRINT)!.approved = true;
    writeFileSync(value.planPath, `${JSON.stringify(closePlan, null, 2)}\n`, "utf8");
    writeRunEvidenceFixture(value.planPath, EVIDENCE_CENSUS, true);
    const events: string[] = [];
    const transport = fakeTransport();
    vi.mocked(transport.appendEvidenceComment).mockImplementation(async () => {
      events.push("append_evidence");
      return { commentId: "IC_202" };
    });
    vi.mocked(transport.closeIssue).mockImplementation(async () => { events.push("close_issue"); });

    await applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true, trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, transport, now: NOW,
      actionQualificationContext: LEGACY_CLOSE_QUALIFICATION,
    });

    expect(events).toEqual(["append_evidence", "close_issue"]);
  });

  it("does not execute close when evidence append fails", async () => {
    const value = fixture();
    value.decisionContent = `${JSON.stringify(addClose(report()), null, 2)}\n`;
    writeFileSync(value.decisionPath, value.decisionContent, "utf8");
    const closePlan = buildIntakeApprovalPlan({
      decisionPath: value.decisionPath, decisionContent: value.decisionContent, now: NOW,
    });
    closePlan.entries.find((entry) => entry.sourceFingerprint === APPEND_FINGERPRINT)!.approved = true;
    writeFileSync(value.planPath, `${JSON.stringify(closePlan, null, 2)}\n`, "utf8");
    writeRunEvidenceFixture(value.planPath, EVIDENCE_CENSUS, true);
    const events: string[] = [];
    const transport = fakeTransport();
    vi.mocked(transport.appendEvidenceComment).mockImplementation(async () => {
      events.push("append_evidence");
      throw new Error("append failed");
    });
    vi.mocked(transport.closeIssue).mockImplementation(async () => { events.push("close_issue"); });

    await expect(applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true, trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, transport, now: NOW,
      actionQualificationContext: LEGACY_CLOSE_QUALIFICATION,
    })).resolves.toMatchObject({ failures: [{ sourceFingerprint: APPEND_FINGERPRINT, action: "append_evidence",
      stage: "dispatch", issueNumber: 42, error: expect.stringMatching(/append failed/i) }] });
    expect(events).toEqual(["append_evidence"]);
    expect(transport.closeIssue).not.toHaveBeenCalled();
  });

  it("preserves landed comment identity when the following close is unresolved", async () => {
    const value = fixture();
    value.decisionContent = `${JSON.stringify(addClose(report()), null, 2)}\n`;
    writeFileSync(value.decisionPath, value.decisionContent, "utf8");
    const closePlan = buildIntakeApprovalPlan({
      decisionPath: value.decisionPath, decisionContent: value.decisionContent, now: NOW,
    });
    closePlan.entries.find((entry) => entry.sourceFingerprint === APPEND_FINGERPRINT)!.approved = true;
    writeFileSync(value.planPath, `${JSON.stringify(closePlan, null, 2)}\n`, "utf8");
    writeRunEvidenceFixture(value.planPath, EVIDENCE_CENSUS, true);
    const transport = fakeTransport();
    vi.mocked(transport.closeIssue).mockRejectedValueOnce(new Error("close unsupported"));

    await expect(applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true,
      trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA,
      transport, now: NOW,
      actionQualificationContext: LEGACY_CLOSE_QUALIFICATION,
    })).resolves.toMatchObject({ failures: [{ sourceFingerprint: APPEND_FINGERPRINT, action: "append_evidence",
      stage: "dispatch", issueNumber: 42, error: expect.stringMatching(/close unsupported/i) }] });

    const unresolved = readFileSync(value.journalPath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((row) => row.event === "create_unresolved");
    expect(unresolved).toMatchObject({
      issueNumber: 42, issueId: null, commentId: "IC_202",
    });
  });

  it("round-trips close evidence and refuses a hand-edited close target", async () => {
    const value = fixture();
    value.decisionContent = `${JSON.stringify(addClose(report()), null, 2)}\n`;
    writeFileSync(value.decisionPath, value.decisionContent, "utf8");
    const closePlan = buildIntakeApprovalPlan({
      decisionPath: value.decisionPath, decisionContent: value.decisionContent, now: NOW,
    });
    const closeEntry = closePlan.entries.find((entry) => entry.sourceFingerprint === APPEND_FINGERPRINT)!;
    expect(closeEntry).toMatchObject({
      intendedActions: ["append_evidence", "close_issue"],
      closeIssue: { targetIssueNumber: 42, before: "OPEN", after: "CLOSED", evidenceIds: ["merged:abc123"] },
    });
    closeEntry.approved = true;
    (closeEntry.closeIssue as { targetIssueNumber: number }).targetIssueNumber = 99;
    writeFileSync(value.planPath, `${JSON.stringify(closePlan, null, 2)}\n`, "utf8");
    writeRunEvidenceFixture(value.planPath, EVIDENCE_CENSUS, true);

    const transport = fakeTransport();
    await expect(applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true, trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, transport, now: NOW,
    })).rejects.toThrow(/changed source-bound fields/i);
    expect(transport.appendEvidenceComment).not.toHaveBeenCalled();
    expect(transport.closeIssue).not.toHaveBeenCalled();
  });
  it("parses a decision report written before hold payloads existed", () => {
    // Every drain collected before hold payloads shipped omits `hold.issue` entirely. Requiring
    // the key would make those reports unreadable rather than merely unadorned, so an absent key
    // and an explicit null must both mean "no fileable payload".
    const legacy = report();
    const held = legacy.candidates.find((candidate) => candidate.presentation === "hold")!;
    delete (held.hold as { issue?: unknown }).issue;
    expect("issue" in (held.hold as object)).toBe(false);

    const root = mkdtempSync(join(tmpdir(), "roadmap-intake-approval-legacy-"));
    const decisionPath = join(root, "decision.json");
    const decisionContent = `${JSON.stringify(legacy, null, 2)}\n`;
    writeFileSync(decisionPath, decisionContent, "utf8");

    const plan = buildIntakeApprovalPlan({ decisionPath, decisionContent, now: NOW });
    const entry = plan.entries.find((candidate) => candidate.sourceFingerprint === HOLD_FINGERPRINT)!;
    expect(entry.presentation).toBe("hold");
    expect(entry.hold?.issue).toBeNull();
    expect(entry.hold?.rationale).toBe("Overlap is unresolved.");
  });

  it("refuses a hold payload that is present but malformed", () => {
    const broken = report();
    const held = broken.candidates.find((candidate) => candidate.presentation === "hold")!;
    (held.hold as { issue: unknown }).issue = { title: "Held outcome" };
    const root = mkdtempSync(join(tmpdir(), "roadmap-intake-approval-broken-"));
    const decisionPath = join(root, "decision.json");
    const decisionContent = `${JSON.stringify(broken, null, 2)}\n`;
    writeFileSync(decisionPath, decisionContent, "utf8");
    expect(() => buildIntakeApprovalPlan({ decisionPath, decisionContent, now: NOW }))
      .toThrow(/hold\.issue\.body/i);
  });

  it("renders every candidate, defaults approval off, makes holds non-approvable, and binds raw decision bytes", () => {
    const value = fixture();
    expect(value.plan.entries).toHaveLength(3);
    expect(value.plan.entries.every((entry) => entry.approved === false)).toBe(true);
    expect(value.plan.entries.find((entry) => entry.sourceFingerprint === HOLD_FINGERPRINT)).toMatchObject({
      presentation: "hold", approvable: false, approved: false, intendedAction: null,
      hold: {
        reason: "plausible_overlap", rationale: "Overlap is unresolved.", competingIssueNumbers: [9],
        issue: {
          title: "Held outcome",
          body: expect.stringContaining(marker(HOLD_FINGERPRINT)),
        },
        competingIssues: [{ number: 9, title: "Existing outcome", state: "OPEN" }],
      },
    });
    const create = value.plan.entries.find((entry) => entry.sourceFingerprint === CREATE_FINGERPRINT)!;
    expect(create.deniedClassification).toEqual(expect.arrayContaining([
      expect.objectContaining({ fieldName: "Type", value: "Task", confidence: "high" }),
      expect.objectContaining({ fieldName: "Priority", value: "P2", confidence: "medium" }),
      expect.objectContaining({ fieldName: "Effort", value: "Medium", confidence: "low" }),
    ]));
    expect(create.deniedClassification.map((entry) => entry.fieldName)).not.toContain("Horizon");
    expect(value.plan.decision.contentSha256).toBe(sha256Content(value.decisionContent));
    expect(value.plan.decision).toMatchObject({
      existenceRecordContentSha256: EXISTENCE_CONTENT_SHA256,
      verifiedOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA,
    });
    expect(value.plan.entries.every((entry) =>
      entry.decisionReport.existenceRecordContentSha256 === EXISTENCE_CONTENT_SHA256 &&
      entry.decisionReport.verifiedOriginMainSha === VERIFIED_ORIGIN_MAIN_SHA)).toBe(true);
  });

  it("carries replay decision reasoning into a non-approvable plan entry", () => {
    const base = report();
    const replayFingerprint = "d".repeat(64);
    const replayReport = {
      ...base,
      decision: { ...base.decision, candidates: [...base.decision.candidates, {
        sourceFingerprint: replayFingerprint,
        actions: [{
          action: "replay_no_op", targetIssueNumber: 12, rationale: "Canonical marker already consumed.",
          evidenceIds: ["issue:12"], confidence: "high",
        }],
      }] },
      candidates: [...base.candidates, {
        sourceFingerprint: replayFingerprint, matchResult: "replay", presentation: "replay_no_op",
        draft: null, hold: null, intendedButDenied: [],
      }],
    };
    const decisionContent = `${JSON.stringify(replayReport, null, 2)}\n`;
    const plan = buildIntakeApprovalPlan({ decisionPath: "replay-decision.json", decisionContent, now: NOW });
    expect(plan.entries.find((entry) => entry.sourceFingerprint === replayFingerprint)).toMatchObject({
      presentation: "replay_no_op", approvable: false, approved: false, hold: null,
      replay: {
        targetIssueNumber: 12, rationale: "Canonical marker already consumed.",
        evidenceIds: ["issue:12"], confidence: "high",
      },
    });
  });

  it("fails closed when the bound decision report bytes change", async () => {
    const value = fixture();
    writeFileSync(value.decisionPath, `${value.decisionContent} `, "utf8");
    await expect(applyIntakeApprovalPlan({ planPath: value.planPath })).rejects.toThrow(/stale.*hash changed/i);
  });

  it("folds repeated decision arguments into one attributed plan", () => {
    const value = fixture();
    const secondPath = join(value.root, "decision-two.json");
    const second = report();
    second.candidates = second.candidates.filter((candidate) => candidate.presentation === "hold");
    second.candidates[0].sourceFingerprint = "d".repeat(64);
    second.decision.candidates = [{ sourceFingerprint: "d".repeat(64), actions: [] }];
    writeFileSync(secondPath, `${JSON.stringify(second, null, 2)}\n`, "utf8");
    const mergedPath = join(value.root, "merged-approval.json");
    const plan = runIntakeApproveCli({
      argv: [`--decision=${value.decisionPath}`, `--decision=${secondPath}`, `--out=${mergedPath}`], now: NOW,
    });
    expect(plan.decisions).toHaveLength(2);
    expect(plan.entries).toHaveLength(4);
    expect(new Set(plan.entries.map((entry) => entry.decisionReport.path))).toEqual(new Set([value.decisionPath, secondPath]));
    expect(plan.entries.every((entry) => entry.approved === false)).toBe(true);
  });

  it("re-checks every report bound by a merged plan", async () => {
    const value = fixture();
    const secondPath = join(value.root, "decision-two.json");
    const second = report();
    second.candidates = second.candidates.filter((candidate) => candidate.presentation === "hold");
    second.candidates[0].sourceFingerprint = "d".repeat(64);
    second.decision.candidates = [{ sourceFingerprint: "d".repeat(64), actions: [] }];
    writeFileSync(secondPath, `${JSON.stringify(second, null, 2)}\n`, "utf8");
    const plan = runIntakeApproveCli({
      argv: [`--decision=${value.decisionPath}`, `--decision=${secondPath}`, `--out=${value.planPath}`], now: NOW,
    });
    expect(plan.entries).toHaveLength(4);
    writeFileSync(secondPath, `${JSON.stringify(second)} `, "utf8");
    await expect(applyIntakeApprovalPlan({ planPath: value.planPath })).rejects.toThrow(/stale.*decision report.*hash changed/i);
  });

  it("refuses an approved hold before opening a transport", async () => {
    const value = fixture();
    value.plan.entries.find((entry) => entry.sourceFingerprint === HOLD_FINGERPRINT)!.approved = true;
    value.persistPlan();
    const transport = fakeTransport();
    await expect(applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true, trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, transport,
    })).rejects.toThrow(/approved hold.*non-approvable/i);
    expect(transport.createIssue).not.toHaveBeenCalled();
  });

  it("refuses a pre-gate decision report with no existence binding before transport open", async () => {
    const value = fixture();
    const oldReport = report();
    delete (oldReport.decision as Partial<typeof oldReport.decision>).existenceRecordContentSha256;
    delete (oldReport.decision as Partial<typeof oldReport.decision>).verifiedOriginMainSha;
    writeFileSync(value.decisionPath, `${JSON.stringify(oldReport, null, 2)}\n`, "utf8");
    (value.plan.decision as { contentSha256: string }).contentSha256 = sha256Content(readFileSync(value.decisionPath));
    (value.plan.decisions[0] as { contentSha256: string }).contentSha256 = value.plan.decision.contentSha256;
    value.plan.entries.forEach((entry) => {
      (entry.decisionReport as { contentSha256: string }).contentSha256 = value.plan.decision.contentSha256;
    });
    value.persistPlan();
    const events: string[] = [];
    await expect(applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true, trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA,
      openTransport: () => { events.push("transport_open"); return fakeTransport(); },
    } as Parameters<typeof applyIntakeApprovalPlan>[0])).rejects.toThrow(/existence binding/i);
    expect(events.findIndex((event) => event === "transport_open")).toBe(-1);
  });

  it("refuses approval planning when operator credentials are present", () => {
    expect(() => runIntakeApproveCli({ argv: [], operatorToken: "operator-secret", now: NOW })).toThrow(/credential-free/i);
  });

  it("refuses execute mode without an operator token", async () => {
    const value = fixture();
    await expect(runIntakeApplyCli({
      argv: [`--plan=${value.planPath}`, "--execute", `--run-evidence=${value.runEvidencePath}`, `--origin-main-sha=${VERIFIED_ORIGIN_MAIN_SHA}`], transport: fakeTransport(),
    })).rejects.toThrow(/ROADMAP_SHADOW_PUBLISH_TOKEN/i);
  });

  it("refuses dry-run mode when an operator token is present", async () => {
    const value = fixture();
    await expect(runIntakeApplyCli({
      argv: [`--plan=${value.planPath}`], operatorToken: "operator-secret", transport: fakeTransport(),
    })).rejects.toThrow(/only for an explicit --execute/i);
  });

  it("dry-runs by default, reports exact intended writes, and records non-executed dispositions", async () => {
    const value = fixture();
    value.plan.entries.find((entry) => entry.sourceFingerprint === CREATE_FINGERPRINT)!.approved = true;
    value.plan.entries.find((entry) => entry.sourceFingerprint === APPEND_FINGERPRINT)!.approved = true;
    value.persistPlan();
    const transport = fakeTransport();
    const output: string[] = [];
    const result = await runIntakeApplyCli({
      argv: [`--plan=${value.planPath}`], transport,
      log: (line) => output.push(line),
    });
    expect(result.mode).toBe("dry-run");
    expect(result.writes.map((write) => write.action)).toEqual(["create_issue", "append_evidence"]);
    expect(result.executionSummary).toMatchObject({ operationsTotal: 0, operations: [],
      countsByState: { never_attempted: 0, complete: 0 }, ageEvidence: { withFirstAttempt: 0, withoutFirstAttempt: 0 } });
    expect(result.writes[0].suggestedHorizon).toBe("Later");
    expect(result.ledgerRecords.some((record) => "suggestedHorizon" in record)).toBe(false);
    expect(result.writes[1]).toMatchObject({ canonicalIssueNumber: 42, evidenceComment: draft(APPEND_FINGERPRINT, "append_evidence", 42).evidenceComment });
    expect(transport.createIssue).not.toHaveBeenCalled();
    expect(transport.appendEvidenceComment).not.toHaveBeenCalled();
    expect(transport.applyClassification).not.toHaveBeenCalled();
    expect(result.ledgerRecords.map((record) => record.disposition)).toEqual(["refused", "refused", "hold"]);
    expect(result.ledgerRecords.every((record) => record.mode === "dry-run")).toBe(true);
    expect(result.ledgerRecords.every((record) => record.executed === false)).toBe(true);
    expect(result.ledgerRecords).toHaveLength(3);
    expect(existsSync(value.journalPath)).toBe(false);
    expect(JSON.parse(output[0]) as unknown).toEqual(result);
  });

  it("shares the post-run repository summary with status and dry-run, including history outside the plan", async () => {
    const value = fixture();
    value.plan.entries[0].approved = true;
    value.persistPlan();
    writeFileSync(value.journalPath, JSON.stringify(durableEvent("create_unresolved", {
      sourceFingerprint: "outside-plan", appliedAt: "2026-08-01T18:00:00.000Z", error: "No response recorded.",
    })) + "\n");
    const result = await applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true,
      trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, transport: fakeTransport(), now: NOW,
    });
    expect(result.executionSummary).toMatchObject({ operationsTotal: 2, unresolved: 1,
      countsByState: { complete: 1, unresolved_unknown: 1 }, oldestUnresolvedAgeDays: 30,
      ageEvidence: { withFirstAttempt: 1, withoutFirstAttempt: 0 } });
    expect(result.executionSummary.operations).toEqual([{
      sourceFingerprint: "outside-plan", action: "create_issue", state: "unresolved_unknown",
      issueNumber: null, issueId: null, commentId: null,
      firstAttemptAt: "2026-08-01T18:00:00.000Z", lastEventAt: "2026-08-01T18:00:00.000Z",
      ageDays: 30, lastError: "No response recorded.",
    }]);
    const log = vi.fn();
    expect(runIntakeResolveCli({ argv: ["status", "--repository=example-org/example-repo"], now: NOW, log })).toBe(0);
    expect(result.executionSummary).toEqual({ ...JSON.parse(log.mock.calls[0][0]).summary,
      reconciliationsRefused: 0, reconciliationsRefusedReasons: {}, reconciliationsNoRunEvidence: 0 });
    const preview = await applyIntakeApprovalPlan({ planPath: value.planPath, now: NOW });
    expect(preview.executionSummary).toEqual(result.executionSummary);
  });

  it("hands the source issue body and evidence comment to the transport byte-for-byte", async () => {
    const value = fixture();
    const createEntry = value.plan.entries.find((entry) => entry.sourceFingerprint === CREATE_FINGERPRINT)!;
    const appendEntry = value.plan.entries.find((entry) => entry.sourceFingerprint === APPEND_FINGERPRINT)!;
    createEntry.approved = true;
    appendEntry.approved = true;
    value.persistPlan();
    const transport = fakeTransport();
    await applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true, trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, transport, now: NOW,
    });
    const createBody = vi.mocked(transport.createIssue).mock.calls[0][1].body;
    const commentBody = vi.mocked(transport.appendEvidenceComment).mock.calls[0][2];
    expect(createBody).toBe(draft(CREATE_FINGERPRINT, "create_issue", null).issue.body);
    expect(commentBody).toBe(draft(APPEND_FINGERPRINT, "append_evidence", 42).evidenceComment);
  });

  it("applies the operator's final classification value", async () => {
    const value = fixture();
    const createEntry = value.plan.entries.find((entry) => entry.sourceFingerprint === CREATE_FINGERPRINT)!;
    createEntry.approved = true;
    createEntry.deniedClassification.find((entry) => entry.fieldName === "Priority")!.value = "P1";
    value.persistPlan();
    const transport = fakeTransport();
    await applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true, trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, transport, now: NOW,
    });
    expect(transport.applyClassification).toHaveBeenCalledWith(
      "example-org/example-repo", 101, { fieldName: "Priority", value: "P1" }, expect.any(Function),
    );
    expect(transport.applyClassification).toHaveBeenCalledWith(
      "example-org/example-repo", 101, { fieldName: "Effort", value: "Medium" }, expect.any(Function),
    );
  });

  it("filters Horizon from a pre-existing plan entry without making the plan fatal", async () => {
    const value = fixture();
    const createEntry = value.plan.entries.find((entry) => entry.sourceFingerprint === CREATE_FINGERPRINT)!;
    createEntry.approved = true;
    createEntry.deniedClassification.push({
      action: "set_horizon", fieldName: "Horizon", value: "Later", confidence: "low",
      rationale: "Legacy approval plans carried this operator-only suggestion.",
    });
    value.persistPlan();
    const transport = fakeTransport();

    const result = await applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true,
      trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA,
      transport, now: NOW,
    });

    expect(result.writes[0]).toMatchObject({ suggestedHorizon: "Later" });
    expect(result.writes[0].classifications.map((entry) => entry.fieldName))
      .toEqual(["Type", "Priority", "Effort"]);
    expect(vi.mocked(transport.applyClassification).mock.calls.some((call) =>
      (call[2].fieldName as string) === "Horizon")).toBe(false);
    expect(result.ledgerRecords[0].operatorFinalClassification.map((entry) => entry.fieldName))
      .not.toContain("Horizon");
  });

  it("records suggested versus final classification for executed, declined, and held entries", async () => {
    const value = fixture();
    const declinedEntry = value.plan.entries.find((entry) => entry.sourceFingerprint === CREATE_FINGERPRINT)!;
    const appendEntry = value.plan.entries.find((entry) => entry.sourceFingerprint === APPEND_FINGERPRINT)!;
    appendEntry.approved = true;
    declinedEntry.deniedClassification.find((entry) => entry.fieldName === "Priority")!.value = "P1";
    value.persistPlan();
    const result = await applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true, trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, transport: fakeTransport(), now: NOW,
    });
    expect(result.ledgerRecords).toHaveLength(3);
    expect(result.ledgerRecords[0]).toMatchObject({
      sourceFingerprint: CREATE_FINGERPRINT,
      assessorSuggestedClassification: expect.arrayContaining([expect.objectContaining({ fieldName: "Priority", value: "P2", confidence: "medium" })]),
      operatorFinalClassification: expect.arrayContaining([expect.objectContaining({ fieldName: "Priority", value: "P1" })]),
      approved: false, executed: false, disposition: "declined", hold: null, actionTaken: null,
    });
    expect(result.ledgerRecords[1]).toMatchObject({
      sourceFingerprint: APPEND_FINGERPRINT, approved: true, executed: true, disposition: "executed",
      hold: null, actionTaken: "append_evidence", result: { issueNumber: 42, issueId: null, commentId: "IC_202" },
    });
    expect(result.ledgerRecords[2]).toMatchObject({
      sourceFingerprint: HOLD_FINGERPRINT, approved: false, executed: false, disposition: "hold",
      hold: {
        reason: "plausible_overlap", rationale: "Overlap is unresolved.", competingIssueNumbers: [9],
      },
    });
  });

  it("preserves one projected result row per plan entry while persisting staged events", async () => {
    const value = fixture();
    value.plan.entries.find((entry) => entry.sourceFingerprint === CREATE_FINGERPRINT)!.approved = true;
    value.plan.entries.find((entry) => entry.sourceFingerprint === APPEND_FINGERPRINT)!.approved = true;
    value.persistPlan();
    const result = await applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true, trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, transport: fakeTransport(), now: NOW,
    });
    const persisted = readFileSync(value.journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as unknown);
    expect(result.ledgerRecords).toHaveLength(value.plan.entries.length);
    expect(persisted.map((row) => (row as { event?: string }).event).filter(Boolean))
      .toEqual(["intent", "created", "complete", "intent", "created", "complete"]);
  });

  it("records replay dispositions without claiming execution", async () => {
    const value = fixture();
    const replayFingerprint = "d".repeat(64);
    const replayReport = report();
    replayReport.decision.candidates.push({
      sourceFingerprint: replayFingerprint,
      actions: [{
        action: "replay_no_op", targetIssueNumber: 12, rationale: "Canonical marker already consumed.",
        evidenceIds: ["issue:12"], confidence: "high",
      }],
    } as never);
    replayReport.candidates.push({
      sourceFingerprint: replayFingerprint, matchResult: "replay", presentation: "replay_no_op",
      draft: null, hold: null, intendedButDenied: [],
    } as never);
    value.decisionContent = `${JSON.stringify(replayReport, null, 2)}\n`;
    writeFileSync(value.decisionPath, value.decisionContent, "utf8");
    const replayPlan = buildIntakeApprovalPlan({
      decisionPath: value.decisionPath, decisionContent: value.decisionContent, now: NOW,
    });
    writeFileSync(value.planPath, `${JSON.stringify(replayPlan, null, 2)}\n`, "utf8");
    writeRunEvidenceFixture(value.planPath, EVIDENCE_CENSUS, true);

    const result = await applyIntakeApprovalPlan({ planPath: value.planPath, now: NOW });
    expect(result.ledgerRecords.find((record) => record.sourceFingerprint === replayFingerprint)).toMatchObject({
      approved: false, executed: false, disposition: "replay", actionTaken: null,
    });
  });

  it("stages create, records classification failure, and resumes classification without recreating", async () => {
    const value = fixture();
    value.plan.entries.find((entry) => entry.sourceFingerprint === CREATE_FINGERPRINT)!.approved = true;
    value.persistPlan();
    const failingTransport = fakeTransport();
    vi.mocked(failingTransport.applyClassification).mockRejectedValueOnce(new Error("classification unavailable"));

    await expect(applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true, trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, transport: failingTransport, now: NOW,
    })).resolves.toMatchObject({ failures: [{ sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue",
      stage: "classification", issueNumber: 101, error: expect.stringMatching(/classification unavailable/i) }] });
    const afterFailure = readFileSync(value.journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(afterFailure.map((row) => row.event)).toEqual(["intent", "created", "classification_failed", undefined, undefined]);
    expect(afterFailure[1]).toMatchObject({ sourceFingerprint: CREATE_FINGERPRINT,
      repository: "example-org/example-repo", issueNumber: 101, issueId: "I_101" });

    // Recovery remains authorized with current approval off and uses the stored
    // contract rather than these edited values.
    value.plan.entries[0].approved = false;
    value.plan.entries[0].deniedClassification.find((entry) => entry.fieldName === "Priority")!.value = "P1";
    value.persistPlan();
    const resumeTransport = fakeTransport();
    const resumed = await applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true, trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, transport: resumeTransport, now: NOW,
    });
    expect(resumeTransport.createIssue).not.toHaveBeenCalled();
    expect(resumeTransport.appendEvidenceComment).not.toHaveBeenCalled();
    expect(resumeTransport.applyClassification).toHaveBeenCalledTimes(3);
    expect(resumeTransport.preflightClassifications).toHaveBeenCalledExactlyOnceWith([{
      repository: "example-org/example-repo", sourceFingerprint: CREATE_FINGERPRINT,
      classifications: [
        { fieldName: "Type", value: "Task" }, { fieldName: "Priority", value: "P2" }, { fieldName: "Effort", value: "Medium" },
      ],
    }]);
    expect(resumeTransport.verifyClassifications).toHaveBeenCalledWith(
      "example-org/example-repo", 101, [
        { fieldName: "Type", value: "Task" },
        { fieldName: "Priority", value: "P2" },
        { fieldName: "Effort", value: "Medium" },
      ],
    );
    expect(resumed.ledgerRecords).toHaveLength(value.plan.entries.length);
    expect(resumed.ledgerRecords[0]).toMatchObject({
      sourceFingerprint: CREATE_FINGERPRINT, executed: true, disposition: "executed",
      result: { issueNumber: 101, issueId: "I_101", commentId: null },
    });
    expect(readFileSync(value.journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line).event))
      .toEqual(["intent", "created", "classification_failed", undefined, undefined, "complete", undefined, undefined]);
  });

  it("records a markerless resume failure with its stored emission hash", async () => {
    const value = fixture();
    value.plan.entries[0].approved = true;
    value.persistPlan();
    const failingTransport = fakeTransport();
    vi.mocked(failingTransport.applyClassification).mockRejectedValueOnce(new Error("classification unavailable"));
    await expect(applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true,
      trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA,
      transport: failingTransport, now: NOW,
    })).resolves.toMatchObject({ failures: [{ sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue",
      stage: "classification", issueNumber: 101, error: expect.stringMatching(/classification unavailable/i) }] });
    const rows = readFileSync(value.journalPath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const failed = rows.findLast((row) => row.event === "classification_failed")!;
    failed.payload = { issue: null, evidenceComment: null, closeIssue: null };
    writeFileSync(value.journalPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");

    const transport = fakeTransport();
    vi.mocked(transport.applyClassification).mockRejectedValueOnce(new Error("resume classification unavailable"));
    await expect(applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true,
      trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA,
      transport, now: NOW,
    })).resolves.toMatchObject({ failures: [{ sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue",
      stage: "recovery", issueNumber: 101, error: expect.stringMatching(/resume classification unavailable/i) }] });
    const resumedFailure = readFileSync(value.journalPath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .findLast((row) => row.event === "classification_failed");
    expect(resumedFailure).toMatchObject({
      emissionContentSha256: failed.emissionContentSha256,
      error: "resume classification unavailable",
    });
  });

  it("never retries an unresolved create or a later emission of the owned outcome", async () => {
    const value = fixture();
    value.plan.entries[0].approved = true;
    value.persistPlan();
    const uncertain = fakeTransport();
    vi.mocked(uncertain.createIssue).mockRejectedValueOnce(new Error("connection reset after dispatch"));

    await expect(applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true,
      trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA,
      transport: uncertain, now: NOW,
    })).resolves.toMatchObject({ failures: [{ sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue",
      stage: "dispatch", issueNumber: null, error: expect.stringMatching(/connection reset/i) }] });
    expect(readFileSync(value.journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line).event))
      .toEqual(["intent", "create_unresolved", undefined, undefined]);

    const intentOnly = readFileSync(value.journalPath, "utf8").split("\n")[0];
    writeFileSync(value.journalPath, `${intentOnly}\n`, "utf8");
    const intentRecovery = fakeTransport();
    const held = await applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true,
      trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA,
      transport: intentRecovery, now: NOW,
    });
    expect(intentRecovery.createIssue).not.toHaveBeenCalled();
    expect(held.ledgerRecords[0]).toMatchObject({ executed: false, disposition: "refused" });
    expect(readFileSync(value.journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line).event))
      .toEqual(["intent", "create_unresolved", undefined, undefined]);

    const source = JSON.parse(value.decisionContent) as ReturnType<typeof report>;
    source.candidates[0].draft!.issue.title = "Revised title, same outcome";
    source.candidates[0].draft!.issue.body = source.candidates[0].draft!.issue.body.replace("Outcome c", "Revised outcome");
    const revisedEmission = "b".repeat(64);
    source.candidates[0].draft!.marker = source.candidates[0].draft!.marker.replace(
      /^emission-content-sha256: [0-9a-f]{64}$/m, `emission-content-sha256: ${revisedEmission}`,
    );
    source.candidates[0].draft!.issue.body = source.candidates[0].draft!.issue.body.replace(
      /^emission-content-sha256: [0-9a-f]{64}$/m, `emission-content-sha256: ${revisedEmission}`,
    );
    value.decisionContent = `${JSON.stringify(source, null, 2)}\n`;
    writeFileSync(value.decisionPath, value.decisionContent, "utf8");
    const revisedPlan = buildIntakeApprovalPlan({
      decisionPath: value.decisionPath, decisionContent: value.decisionContent, now: NOW,
    });
    revisedPlan.entries[0].approved = true;
    writeFileSync(value.planPath, `${JSON.stringify(revisedPlan, null, 2)}\n`, "utf8");
    writeRunEvidenceFixture(value.planPath, EVIDENCE_CENSUS, true);
    const retry = fakeTransport();
    const result = await applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true,
      trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA,
      transport: retry, now: NOW,
    });
    expect(retry.createIssue).not.toHaveBeenCalled();
    expect(result.ledgerRecords[0]).toMatchObject({ executed: false, disposition: "refused" });
  });

  it("refuses legacy execution without mutation and continues an unrelated approved entry", async () => {
    const value = fixture();
    value.plan.entries.find((entry) => entry.sourceFingerprint === APPEND_FINGERPRINT)!.approved = true;
    value.persistPlan();
    const source = value.plan.entries[0];
    writeFileSync(value.journalPath, `${JSON.stringify({
      schemaVersion: "github-issue-roadmap-intake-approval-ledger/v1", appliedAt: NOW.toISOString(),
      mode: "execute", decisionContentSha256: source.decisionReport.contentSha256,
      sourceFingerprint: source.sourceFingerprint, candidateFingerprint: source.sourceFingerprint,
      operatorFinalClassification: source.deniedClassification.map(({ fieldName, value }) => ({ fieldName, value })),
      approved: true, executed: true, disposition: "executed", intendedAction: "create_issue",
      intendedActions: ["create_issue"], actionTaken: "create_issue", actionsTaken: ["create_issue"],
      result: { issueNumber: 101, issueId: "I_101", commentId: null },
    })}\n`, "utf8");
    const transport = fakeTransport();

    const result = await applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true,
      trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA,
      transport, now: NOW,
    });
    expect(transport.createIssue).not.toHaveBeenCalled();
    expect(transport.appendEvidenceComment).toHaveBeenCalledTimes(1);
    expect(transport.applyClassification).not.toHaveBeenCalled();
    expect(result.ledgerRecords.find((record) => record.sourceFingerprint === CREATE_FINGERPRINT)).toMatchObject({
      executed: false,
      disposition: "refused",
      refusalReason: "Legacy execution is recorded; classification is unverified; explicit reconciliation is required.",
      result: { issueNumber: 101, issueId: "I_101", commentId: null },
    });
    const persisted = readFileSync(value.journalPath, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(persisted.some((row) => row.event === "complete" && row.sourceFingerprint === CREATE_FINGERPRINT)).toBe(false);
  });

  it.each([
    { metadata: "missing", operatorFinalClassification: undefined },
    { metadata: "malformed", operatorFinalClassification: [null, { fieldName: "Priority", value: 42 }] },
  ])("suppresses approved redispatch for legacy execution with $metadata classification metadata", async ({
    operatorFinalClassification,
  }) => {
    const value = fixture();
    value.plan.entries[0].approved = true;
    value.persistPlan();
    const source = value.plan.entries[0];
    writeFileSync(value.journalPath, `${JSON.stringify({
      schemaVersion: "github-issue-roadmap-intake-approval-ledger/v1", appliedAt: NOW.toISOString(),
      mode: "execute", decisionContentSha256: source.decisionReport.contentSha256,
      sourceFingerprint: source.sourceFingerprint, candidateFingerprint: source.sourceFingerprint,
      ...(operatorFinalClassification === undefined ? {} : { operatorFinalClassification }),
      approved: true, executed: true, disposition: "executed", intendedAction: "create_issue",
      intendedActions: ["create_issue"], actionTaken: "create_issue", actionsTaken: ["create_issue"],
      result: { issueNumber: 101, issueId: "I_101", commentId: null },
    })}\n`, "utf8");
    const transport = fakeTransport();

    const result = await applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true,
      trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA,
      transport, now: NOW,
    });

    expect(transport.createIssue).not.toHaveBeenCalled();
    expect(transport.applyClassification).not.toHaveBeenCalled();
    expect(result.ledgerRecords[0]).toMatchObject({
      executed: false, disposition: "refused",
      refusalReason: "Legacy execution is recorded; classification is unverified; explicit reconciliation is required.",
      result: { issueNumber: 101, issueId: "I_101", commentId: null },
    });
  });

  it("projects durable completion after the plan is rebuilt without approval", async () => {
    const value = fixture();
    value.plan.entries[0].approved = true;
    value.persistPlan();
    await applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true,
      trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA,
      transport: fakeTransport(), now: NOW,
    });
    value.plan.entries[0].approved = false;
    value.plan.entries[0].deniedClassification.find((entry) => entry.fieldName === "Priority")!.value = "P1";
    value.persistPlan();

    const projected = await applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true,
      trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA,
      transport: fakeTransport(), now: NOW,
    });

    expect(projected.ledgerRecords[0]).toMatchObject({
      sourceFingerprint: CREATE_FINGERPRINT, executed: true, disposition: "executed",
      actionTaken: "create_issue", actionsTaken: ["create_issue"],
      operatorFinalClassification: expect.arrayContaining([{ fieldName: "Priority", value: "P2" }]),
      result: { issueNumber: 101, issueId: "I_101", commentId: null },
    });
  });

  it("leaves mismatching or unavailable read-back unconfirmed", async () => {
    for (const verification of [false, new Error("read-back unavailable")]) {
      vi.stubEnv("ROADMAP_INTAKE_JOURNAL_ROOT", join(journalRoot, verification instanceof Error ? "unavailable" : "mismatch"));
      const value = fixture();
      value.plan.entries[0].approved = true;
      value.persistPlan();
      const transport = fakeTransport();
      if (verification instanceof Error) vi.mocked(transport.verifyClassifications).mockRejectedValue(verification);
      else vi.mocked(transport.verifyClassifications).mockResolvedValue(verification);
      await expect(applyIntakeApprovalPlan({
        ...value.execution, planPath: value.planPath, execute: true,
        trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA,
        transport, now: NOW,
      })).resolves.toMatchObject({ failures: [{ sourceFingerprint: CREATE_FINGERPRINT, action: "create_issue",
        stage: "classification", issueNumber: 101, error: expect.stringMatching(/classification read-back/i) }] });
      const events = readFileSync(value.journalPath, "utf8").trim().split("\n").map((line) => JSON.parse(line).event);
      expect(events).toEqual(["intent", "created", "classification_failed", undefined, undefined]);
    }
  });

  it("does not let imported dry-run ledger observations block later execution", async () => {
    const value = fixture();
    value.plan.entries.find((entry) => entry.sourceFingerprint === CREATE_FINGERPRINT)!.approved = true;
    value.persistPlan();
    const preview = await applyIntakeApprovalPlan({ planPath: value.planPath, now: NOW });
    const ledger = join(value.root, "legacy-dry-run.jsonl");
    writeFileSync(ledger, preview.ledgerRecords.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
    expect(importLegacyLedgers(value.journalPath, [ledger])).toEqual({ imported: 3, skipped: 0, rejected: 0, malformed: 0, rejectedLines: [], malformedLines: [] });
    const transport = fakeTransport();

    const executed = await applyIntakeApprovalPlan({
      ...value.execution, planPath: value.planPath, execute: true, trustedCurrentOriginMainSha: VERIFIED_ORIGIN_MAIN_SHA, transport, now: NOW,
    });

    expect(transport.createIssue).toHaveBeenCalledTimes(1);
    expect(executed.ledgerRecords.find((record) => record.sourceFingerprint === CREATE_FINGERPRINT)).toMatchObject({
      mode: "execute", executed: true, disposition: "executed",
    });
  });

  it("refuses a source draft whose marker cannot be preserved exactly", async () => {
    const value = fixture();
    const broken = report();
    const sourceDraft = broken.candidates[0].draft!;
    sourceDraft.issue.body = `${sourceDraft.issue.body}\ntrailing re-rendered bytes`;
    value.decisionContent = `${JSON.stringify(broken, null, 2)}\n`;
    writeFileSync(value.decisionPath, value.decisionContent, "utf8");
    const plan = buildIntakeApprovalPlan({
      decisionPath: value.decisionPath, decisionContent: value.decisionContent, now: NOW,
    });
    plan.entries[0].approved = true;
    writeFileSync(value.planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    writeRunEvidenceFixture(value.planPath, EVIDENCE_CENSUS, true);

    await expect(applyIntakeApprovalPlan({
      planPath: value.planPath,
    })).rejects.toThrow(/marker.*cannot be preserved exactly/i);
    expect(existsSync(value.journalPath)).toBe(false);
  });

  it("refuses a plan that edits draft content instead of only approval and classification values", async () => {
    const value = fixture();
    const create = value.plan.entries.find((entry) => entry.sourceFingerprint === CREATE_FINGERPRINT)!;
    create.approved = true;
    (create.issue as { title: string; body: string }).body = create.issue!.body.replace(marker(CREATE_FINGERPRINT), "re-rendered marker");
    value.persistPlan();
    await expect(applyIntakeApprovalPlan({ planPath: value.planPath })).rejects.toThrow(/changed source-bound fields/i);
  });
});
