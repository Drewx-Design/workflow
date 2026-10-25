import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { buildIntakeApprovalPlan } from "../github-issue-roadmap-intake-approve";
import {
  applyIntakeApprovalPlan, assertNoDispositionBeforeWrite, confirmClassification, deriveRepositoryCreateBudget, eventWrite, executionEvent, indexHistory,
  INTAKE_CREATE_LIMITS, resolveDurableState, runIntakeApplyCli, type ApprovalExecutionEvent, type IntakeApplyResult, type OperatorIntakeApprovalTransport,
} from "../github-issue-roadmap-intake-apply";
import { createGitHubIntakeApprovalTransport, type FieldEventSnapshot } from "../lib/github-issue-roadmap/github-intake-approval-transport";
import { runCredentialCleanGit } from "../lib/github-issue-roadmap/credential-clean-git";
import { dispositionHistory } from "../lib/github-issue-roadmap/disposition-history";
import { parseIntakeAssessment } from "../lib/github-issue-roadmap/intake-assessment";
import { compileIntakeDecision, compileIntakeExistenceRoutes, deriveIntakeObservationOperands } from "../lib/github-issue-roadmap/intake-decision";
import { assertDecisionBindings } from "../github-issue-roadmap-intake";
import { acquireExecutionClaim, appendJournal, readJournal, resolveJournalPath } from "../lib/github-issue-roadmap/intake-execution-journal";
import { buildRunEvidence } from "../lib/github-issue-roadmap/intake-run-evidence";
import { runIntakeShadow } from "../lib/github-issue-roadmap/intake-shadow";
import { createOutcomeEnvelope, OUTCOME_ENVELOPE_SCHEMA_VERSION_V2 } from "../lib/github-issue-roadmap/outcome-candidate";
import { buildIntakeStack, censusIssue, markerBlock, STACK_ORIGIN_MAIN_SHA, stackEnvelope } from "./__helpers__/roadmap-intake-stack";
import capabilities from "../github-issue-roadmap-capabilities.json";
import { parseDispatcherCapabilityManifest } from "../lib/github-issue-roadmap/capability-manifest";

const REPOSITORY = "example-org/example-repo";
const NOW = new Date("2026-09-17T12:00:00.000Z");
const roots: string[] = [];
let previousExitCode: typeof process.exitCode;
beforeEach(() => {
  previousExitCode = process.exitCode;
  const root = mkdtempSync(join(tmpdir(), "roadmap-create-quota-"));
  roots.push(root);
  vi.stubEnv("ROADMAP_INTAKE_JOURNAL_ROOT", join(root, "journal"));
});
afterEach(() => {
  process.exitCode = previousExitCode;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeGit(_cwd: string, args: readonly string[]): string {
  if (args[0] === "rev-parse" && args.includes("--is-shallow-repository")) return "false";
  if (args[0] === "rev-parse" && args[2] === "origin/main^{commit}") return STACK_ORIGIN_MAIN_SHA;
  if (args[0] === "rev-parse") return args[2].replace("^{commit}", "");
  if (args[0] === "ls-tree" || args[0] === "log") return "";
  throw new Error(`Unexpected Git call ${args.join(" ")}`);
}

function fixture(count = 1, suffix = "first", append = false, replay = false, close = false) {
  const root = join(roots[0], suffix);
  const artifacts = join(root, "artifacts/github-issue-roadmap");
  mkdirSync(artifacts, { recursive: true });
  const base = stackEnvelope(count);
  const envelope = createOutcomeEnvelope({ ...base, artifact: { ...base.artifact, stableId: append ? "append-identity" : suffix },
    candidates: base.candidates.map(({ sourceFingerprint: _source, emissionContentSha256: _emission, ...candidate }) => ({
      ...candidate, ...(append ? { evidence: [...candidate.evidence, { ...candidate.evidence[0], id: suffix }] } : {}),
    })) });
  const stack = buildIntakeStack({ envelope, capabilities: [append ? "append_evidence" : "create_issue"],
    ...(append ? { issues: [censusIssue({ body: markerBlock(envelope, envelope.candidates[0], replay ? envelope.candidates[0].emissionContentSha256 : "a".repeat(64)) })] } : {}) });
  const write = (name: string, value: unknown) => {
    const path = join(artifacts, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const candidatePath = write("candidate.json", envelope);
  const existencePath = write("existence.json", stack.existenceRecord);
  const snapshotPath = write("snapshot.json", stack.snapshot);
  const assessmentPath = write("assessment.json", stack.assessment);
  const shadow = runIntakeShadow({ dispositionHistory: () => new Map(), candidate: candidatePath, snapshot: snapshotPath, assessment: assessmentPath,
    existence: existencePath, verifiedOriginMainSha: STACK_ORIGIN_MAIN_SHA,
    capabilities: write("capabilities.json", stack.capabilityManifest), out: join(artifacts, "decision.json"),
    repoRoot: root, now: new Date("2026-08-20T12:01:00.000Z"), log: () => {} });
  if (close) {
    expect(append).toBe(true);
    const report = JSON.parse(readFileSync(shadow.outputPath, "utf8"));
    const draft = report.candidates[0].draft;
    const targetIssueNumber = draft.canonicalIssueNumber;
    draft.intendedActions = ["append_evidence", "close_issue"];
    draft.closeIssue = { targetIssueNumber, before: "OPEN", after: "CLOSED", evidenceIds: ["completion-proof"] };
    report.decision.candidates[0].actions.push({ action: "close_issue", targetIssueNumber, before: "OPEN", proposed: "CLOSED",
      evidenceIds: ["completion-proof"], confidence: "high", rationale: "Completion proof permits closing the issue." });
    writeFileSync(shadow.outputPath, JSON.stringify(report));
  }
  const plan = buildIntakeApprovalPlan({ decisionPath: shadow.outputPath, decisionContent: readFileSync(shadow.outputPath, "utf8"), now: NOW });
  if (replay) for (const entry of plan.entries) { expect(entry.intendedAction).toBeNull(); expect(entry.presentation).toBe("replay_no_op"); }
  else for (const entry of plan.entries) { expect(entry.intendedAction).toBe(append ? "append_evidence" : "create_issue"); entry.approved = true; }
  const planPath = write("approval.json", plan);
  const named = (path: string) => ({ path: basename(path), bytes: readFileSync(path) });
  const evidence = buildRunEvidence({ runId: suffix, repository: REPOSITORY, preparedAt: NOW.toISOString(),
    approvalPlan: named(planPath), census: named(snapshotPath), decisions: [{ decision: named(shadow.outputPath),
      candidate: named(candidatePath), snapshot: named(snapshotPath), assessment: named(assessmentPath) }] });
  if (!evidence.ok) throw new Error(`${evidence.reason}: ${evidence.detail}`);
  const runEvidencePath = write("run-evidence.json", evidence.evidence);
  let nextIssueNumber = 2101;
  const transport = {
    preflightClassifications: vi.fn(async (_entries: readonly unknown[]) => {}),
    createIssue: vi.fn(async () => { const issueNumber = nextIssueNumber++; return { issueNumber, issueId: `I_${issueNumber}` }; }),
    appendEvidenceComment: vi.fn(async () => ({ commentId: "C_1" })),
    closeIssue: vi.fn(async () => {}), applyClassification: vi.fn(async () => ({})),
    verifyClassifications: vi.fn(async () => true),
  };
  const openTransport = vi.fn(() => transport);
  const input = { planPath, runEvidencePath, execute: true, immediate: true, now: NOW,
    trustedCurrentOriginMainSha: STACK_ORIGIN_MAIN_SHA, candidatePaths: [candidatePath], existencePaths: [existencePath],
    repoRoot: root, runGit: fakeGit, openTransport };
  const cliArgs = [`--plan=${planPath}`, `--run-evidence=${runEvidencePath}`, "--execute",
    `--origin-main-sha=${STACK_ORIGIN_MAIN_SHA}`, `--candidate=${candidatePath}`, `--existence=${existencePath}`];
  return { root, plan, input, transport, openTransport, cliArgs, envelope };
}

function intent(index = 0, overrides: Partial<ApprovalExecutionEvent> = {}): ApprovalExecutionEvent {
  return { schemaVersion: "github-issue-roadmap-intake-approval-ledger/v1", event: "intent", appliedAt: NOW.toISOString(),
    repository: REPOSITORY, sourceFingerprint: `seed-${index}`, action: "create_issue",
    emissionContentSha256: "a".repeat(64), decisionContentSha256: "b".repeat(64),
    payload: { issue: { title: "Budget seed", body: "Unconfirmed attempt" }, evidenceComment: null, closeIssue: null },
    classifications: [], issueNumber: null, issueId: null, commentId: null, ...overrides };
}

function seed(count: number, now = NOW) {
  const path = resolveJournalPath(REPOSITORY);
  const claim = acquireExecutionClaim(path, { mode: "execute" });
  try {
    for (let index = 0; index < count; index += 1) claim.withOwnership(() => appendJournal(path, intent(index, { appliedAt: now.toISOString() })));
  } finally { claim.release(); }
}

function budget(now = NOW) {
  const journal = readJournal(resolveJournalPath(REPOSITORY));
  return deriveRepositoryCreateBudget(indexHistory(journal.records, journal.tail), REPOSITORY, now);
}

function untouched(value: Pick<ReturnType<typeof fixture>, "openTransport" | "transport">) {
  expect(value.openTransport).not.toHaveBeenCalled();
  for (const method of Object.values(value.transport)) expect(method).not.toHaveBeenCalled();
}

describe("fresh disposition checks", () => {
  it("requires explicit history in assessment, binding, routing and compiler contracts", () => {
    expectTypeOf<Parameters<typeof parseIntakeAssessment>["length"]>().toEqualTypeOf<5>();
    expectTypeOf<Parameters<typeof assertDecisionBindings>["length"]>().toEqualTypeOf<3>();
    expectTypeOf<{}>().not.toMatchTypeOf<Pick<Parameters<typeof compileIntakeDecision>[0], "dispositionHistory">>();
    expectTypeOf<{}>().not.toMatchTypeOf<Pick<Parameters<typeof compileIntakeExistenceRoutes>[0], "dispositionHistory">>();
    expectTypeOf<{}>().not.toMatchTypeOf<Pick<Parameters<typeof deriveIntakeObservationOperands>[0], "dispositionHistory">>();
  });

  it.each(["unresolved", "discarded-create", "redispatch"])("rejects a %s withdrawal history instead of releasing uncertain damage", kind => {
    const start = intent();
    const withdrawal: ApprovalExecutionEvent = { ...start, event: "withdrawn_dispositioned", completedActions: [] };
    const rows = kind === "unresolved" ? [start, { ...start, event: "create_unresolved" }, withdrawal]
      : kind === "discarded-create" ? [start, { ...start, event: "created", issueNumber: 7, issueId: "I_7" }, withdrawal]
        : [start, withdrawal, { ...start, event: "created", issueNumber: 7, issueId: "I_7" }];
    const history = indexHistory(rows);
    expect(history.malformed.length + history.conflicts.length).toBeGreaterThan(0);
    expect(deriveRepositoryCreateBudget(history, REPOSITORY, NOW).problem).toBeDefined();
  });

  function disposedGit(value: ReturnType<typeof fixture>, afterIntent = true) {
    const fresh = "c".repeat(40);
    const envelope = createOutcomeEnvelope({ ...value.envelope, schemaVersion: OUTCOME_ENVELOPE_SCHEMA_VERSION_V2,
      candidates: value.envelope.candidates.map(({ sourceFingerprint: _s, emissionContentSha256: _e, ...candidate }) => ({
        ...candidate, disposition: { kind: "achieved" as const, commits: [{ sha: STACK_ORIGIN_MAIN_SHA }], note: "Completed." },
      })) });
    return vi.fn((cwd: string, args: readonly string[]) => {
      if (args[0] === "rev-parse" && args[2] === "origin/main^{commit}") {
        if (afterIntent && readJournal(resolveJournalPath(REPOSITORY)).records.length === 0) return STACK_ORIGIN_MAIN_SHA;
        if (afterIntent) expect(readJournal(resolveJournalPath(REPOSITORY)).records).toContainEqual(expect.objectContaining({ event: "intent" }));
        return fresh;
      }
      if (args[0] === "log" && args.includes("--raw")) return args.includes(fresh)
        ? `${fresh}\n:000000 100644 ${"0".repeat(40)} ${"b".repeat(40)} A\tartifacts/github-issue-roadmap/test.roadmap-outcomes.json\n` : "";
      if (args[0] === "cat-file") return Buffer.from(JSON.stringify(envelope)).toString("base64");
      return fakeGit(cwd, args);
    });
  }

  it.each([false, true])("refuses a disposition at the trusted SHA despite stale local main (append=%s)", async append => {
    const value = fixture(1, "pinned-disposition", append);
    const trustedSha = "c".repeat(40);
    const historicalGit = disposedGit(value, false);
    const runGit = vi.fn((cwd: string, args: readonly string[]) =>
      args[0] === "rev-parse" && args[2] === "origin/main^{commit}"
        ? STACK_ORIGIN_MAIN_SHA : historicalGit(cwd, args));
    expect(dispositionHistory(STACK_ORIGIN_MAIN_SHA, { repoRoot: value.root, runGit }).size).toBe(0);
    expect(dispositionHistory(trustedSha, { repoRoot: value.root, runGit }).has(value.envelope.candidates[0].stableOutcomeId)).toBe(true);
    const input = { ...value.input, trustedCurrentOriginMainSha: trustedSha, runGit };
    const result = await applyIntakeApprovalPlan(input);
    untouched(value);
    expect(result.writes).toEqual([]);
    expect(result.ledgerRecords[0]).toMatchObject({ durableState: "never_attempted", disposition: "refused",
      refusalReason: `dispositioned: approval entry is terminal at trusted main SHA ${trustedSha}.`,
      executed: false, actionsTaken: [], result: { issueNumber: null, issueId: null, commentId: null } });
    expect(result.ledgerRecords[0].existenceRevalidation).toBeUndefined();
    expect(result.failures).toMatchObject([{ stage: "projection", error: expect.stringContaining("dispositioned:") }]);
    expect(readJournal(resolveJournalPath(REPOSITORY)).records).toEqual([]);
    expect(budget()).toMatchObject({ count: 0 });
    expect(budget().problem).toBeUndefined();
    expect((await applyIntakeApprovalPlan(input)).ledgerRecords[0].disposition).toBe("refused");
    untouched(value);
    expect(readJournal(resolveJournalPath(REPOSITORY)).records).toEqual([]);
  });

  it("withdraws after intent with zero writes, releases the budget and never redispatches on replay", async () => {
    const value = fixture();
    const historyLookup = vi.fn<typeof dispositionHistory>((ref, options) => {
      const events = readJournal(resolveJournalPath(REPOSITORY)).records.map(record => (record as ApprovalExecutionEvent).event);
      expect(events).toEqual(events.includes("withdrawn_dispositioned") ? ["intent", "withdrawn_dispositioned"]
        : events.includes("intent") ? ["intent"] : []);
      return dispositionHistory(ref, options);
    });
    const input = { ...value.input, runGit: disposedGit(value), dispositionHistory: historyLookup };
    const result = await applyIntakeApprovalPlan(input);
    expect(historyLookup).toHaveBeenCalledTimes(6);
    for (const call of [1, 2, 5]) expect(historyLookup).toHaveBeenNthCalledWith(call, STACK_ORIGIN_MAIN_SHA,
      { repoRoot: value.root, runGit: input.runGit });
    for (const call of [3, 4, 6]) expect(historyLookup).toHaveBeenNthCalledWith(call, "origin/main",
      { repoRoot: value.root, runGit: input.runGit });
    expect(result.ledgerRecords[0]).toMatchObject({ durableState: "withdrawn_dispositioned", disposition: "dispositioned",
      executed: false, actionsTaken: [], result: { issueNumber: null, issueId: null, commentId: null } });
    expect(result.failures).toEqual([]);
    expect(result.ledgerRecords).toHaveLength(value.plan.entries.length);
    for (const method of [value.transport.createIssue, value.transport.appendEvidenceComment, value.transport.closeIssue, value.transport.applyClassification]) {
      expect(method).not.toHaveBeenCalled();
    }
    const journal = readJournal(resolveJournalPath(REPOSITORY));
    expect(journal.records.map(record => (record as ApprovalExecutionEvent).event)).toEqual(["intent", "withdrawn_dispositioned"]);
    expect(indexHistory(journal.records).malformed).toEqual([]);
    expect(budget()).toMatchObject({ count: 0 });
    expect(budget().problem).toBeUndefined();
    expect((await applyIntakeApprovalPlan(input)).ledgerRecords[0].durableState).toBe("withdrawn_dispositioned");
    expect(value.transport.createIssue).not.toHaveBeenCalled();
    expect(readJournal(resolveJournalPath(REPOSITORY)).records).toEqual(journal.records);
  });

  it("stops recovery classifications when main dispositioned the outcome, retaining the completed create and charge", async () => {
    const value = fixture();
    value.transport.verifyClassifications.mockResolvedValueOnce(false);
    expect((await applyIntakeApprovalPlan(value.input)).ledgerRecords[0].durableState).toBe("classification_failed");
    value.transport.applyClassification.mockClear();
    const result = await applyIntakeApprovalPlan({ ...value.input, runGit: disposedGit(value), dispositionHistory });
    expect(value.transport.applyClassification).not.toHaveBeenCalled();
    expect(value.transport.createIssue).toHaveBeenCalledOnce();
    expect(result.ledgerRecords[0]).toMatchObject({ durableState: "withdrawn_dispositioned", actionsTaken: ["create_issue"],
      result: { issueNumber: 2101, issueId: "I_2101" } });
    expect(budget().count).toBe(1);
  });

  it("refuses unreadable fresh main before create without recording create_unresolved", async () => {
    const value = fixture();
    await expect(applyIntakeApprovalPlan({ ...value.input, runGit: (cwd, args) => {
      if (args.includes("origin/main^{commit}")) throw new Error("Missing main");
      return fakeGit(cwd, args);
    } })).rejects.toThrow("disposition_history_unavailable:");
    expect(value.transport.createIssue).not.toHaveBeenCalled();
    expect(value.transport.appendEvidenceComment).not.toHaveBeenCalled();
    expect(value.transport.closeIssue).not.toHaveBeenCalled();
    expect(value.transport.applyClassification).not.toHaveBeenCalled();
    expect(readJournal(resolveJournalPath(REPOSITORY)).records).toEqual([]);
    expect(budget()).toMatchObject({ count: 0 });
    expect(budget().problem).toBeUndefined();
  });

  it.each(["intent_unknown", "primary_unverified", "classification_failed"] as const)(
    "refuses an unbound old %s journal contract before transport while a bound entry proceeds", async state => {
      const value = fixture(1, "old-unbound-and-healthy");
      const fingerprint = "0".repeat(64);
      const write: IntakeApplyResult["writes"][number] = { sourceFingerprint: fingerprint, repository: REPOSITORY,
        action: "create_issue", actions: ["create_issue"], canonicalIssueNumber: null,
        issue: { title: "Old title", body: "Old payload without outcome markers." }, evidenceComment: null, closeIssue: null,
        classifications: [], suggestedHorizon: null, emissionContentSha256: "a".repeat(64) };
      const start = executionEvent({ event: "intent", now: NOW, write, decisionContentSha256: "b".repeat(64) });
      const rows = [start];
      if (state !== "intent_unknown") rows.push(executionEvent({ event: "created", now: NOW, write,
        decisionContentSha256: start.decisionContentSha256, issueNumber: 7, issueId: "I_7" }));
      if (state === "classification_failed") rows.push(executionEvent({ event: "classification_failed", now: NOW, write,
        decisionContentSha256: start.decisionContentSha256, issueNumber: 7, issueId: "I_7", error: "Prior classification failure" }));
      const path = resolveJournalPath(REPOSITORY);
      const claim = acquireExecutionClaim(path, { mode: "execute" });
      try { for (const row of rows) claim.withOwnership(() => appendJournal(path, row)); }
      finally { claim.release(); }
      const journalBefore = readJournal(path);
      const priorState = resolveDurableState(indexHistory(journalBefore.records, journalBefore.tail), start);
      expect(priorState.kind).toBe(state);
      if (priorState.kind !== "intent_unknown" && priorState.kind !== "primary_unverified"
        && priorState.kind !== "classification_failed") throw new Error("Expected the old operation journal state.");
      // Apply's recovery precheck guards this same production-written, marker-free contract.
      expect(() => assertNoDispositionBeforeWrite(eventWrite(priorState.operation.event), value.input))
        .toThrow("unbound_outcome_identity: write has no bound outcome identity.");
      untouched(value);
      expect(readJournal(path).records).toEqual(rows);
      const result = await applyIntakeApprovalPlan(value.input);
      expect(result.ledgerRecords).toHaveLength(1);
      expect(result.ledgerRecords[0]).toMatchObject({ sourceFingerprint: value.envelope.candidates[0].sourceFingerprint,
        durableState: "complete", disposition: "executed" });
      expect(result.failures).toEqual([]);
      expect(value.transport.createIssue).toHaveBeenCalledExactlyOnceWith(REPOSITORY,
        expect.objectContaining({ body: expect.stringContaining(value.envelope.candidates[0].sourceFingerprint) }), expect.any(Function));
      expect(value.transport.preflightClassifications).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({ sourceFingerprint: value.envelope.candidates[0].sourceFingerprint }),
      ]);
      expect(value.transport.verifyClassifications).toHaveBeenCalledOnce();
      expect(value.transport.appendEvidenceComment).not.toHaveBeenCalled();
      expect(value.transport.closeIssue).not.toHaveBeenCalled();
      const journal = readJournal(path);
      expect(journal.records.filter(row => (row as ApprovalExecutionEvent).sourceFingerprint === fingerprint)).toEqual(rows);
      expect(indexHistory(journal.records).malformed).toEqual([]);
      expect(indexHistory(journal.records).conflicts).toEqual([]);
    });

  it("aborts both entries before transport when disposition history is unreadable", async () => {
    const value = fixture(2, "history-unreadable");
    await expect(applyIntakeApprovalPlan({ ...value.input, dispositionHistory: () => {
      throw new Error("disposition_history_unavailable: cannot index main.");
    } })).rejects.toThrow("disposition_history_unavailable: cannot index main.");
    untouched(value);
    expect(readJournal(resolveJournalPath(REPOSITORY)).records).toEqual([]);
  });

  it("keeps the production history default fail closed without origin/main", async () => {
    const value = fixture();
    const runGit = vi.fn((cwd: string, args: readonly string[]) => {
      if (args.includes("origin/main^{commit}")) return runCredentialCleanGit(cwd, args);
      return fakeGit(cwd, args);
    });
    await expect(applyIntakeApprovalPlan({ ...value.input, runGit }))
      .rejects.toThrow("disposition_history_unavailable: cannot read origin/main.");
    expect(runGit).toHaveBeenCalledWith(value.root, ["rev-parse", "--verify", "origin/main^{commit}"], { localObjectsOnly: true });
    for (const method of [value.transport.createIssue, value.transport.appendEvidenceComment, value.transport.closeIssue, value.transport.applyClassification]) {
      expect(method).not.toHaveBeenCalled();
    }
    expect(readJournal(resolveJournalPath(REPOSITORY)).records).toEqual([]);
    expect(budget()).toMatchObject({ count: 0 });
    expect(budget().problem).toBeUndefined();
  });

  it("re-throws unreadable history at the dispatch guard when nothing was dispatched, keeping only the intent", async () => {
    const value = fixture();
    const historyLookup = vi.fn<typeof dispositionHistory>(() => {
      const kinds = readJournal(resolveJournalPath(REPOSITORY)).records.map(record => (record as ApprovalExecutionEvent).event);
      if (kinds.includes("intent")) throw new Error("disposition_history_unavailable: cannot read origin/main.");
      return new Map();
    });
    await expect(applyIntakeApprovalPlan({ ...value.input, dispositionHistory: historyLookup }))
      .rejects.toThrow("disposition_history_unavailable:");
    expect(historyLookup.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(readJournal(resolveJournalPath(REPOSITORY)).records.map(record => (record as ApprovalExecutionEvent).event)).toEqual(["intent"]);
    for (const method of [value.transport.createIssue, value.transport.appendEvidenceComment, value.transport.closeIssue, value.transport.applyClassification]) {
      expect(method).not.toHaveBeenCalled();
    }
  });

  it("retains the appended comment when fresh main is unreadable before close", async () => {
    const value = fixture(1, "append-close", true, false, true);
    let appended = false;
    value.transport.appendEvidenceComment.mockImplementation(async () => { appended = true; return { commentId: "C_landed" }; });
    const result = await applyIntakeApprovalPlan({ ...value.input, runGit: (cwd, args) => {
      if (appended && args.includes("origin/main^{commit}")) throw new Error("Missing main before close");
      return fakeGit(cwd, args);
    }, actionQualificationContext: { manifest: parseDispatcherCapabilityManifest({ ...capabilities,
      capabilities: capabilities.capabilities.map(entry => entry.actionKinds.includes("close_issue")
        ? { ...entry, entrypoint: "automatic", enabled: true, qualification: "production" } : entry),
    }) } });
    expect(value.transport.appendEvidenceComment).toHaveBeenCalledOnce();
    expect(value.transport.closeIssue).not.toHaveBeenCalled();
    expect(value.transport.createIssue).not.toHaveBeenCalled();
    expect(value.transport.applyClassification).not.toHaveBeenCalled();
    const journal = readJournal(resolveJournalPath(REPOSITORY));
    expect(journal.records.map(record => (record as ApprovalExecutionEvent).event)).toEqual(["intent", "create_unresolved"]);
    expect(journal.records[1]).toMatchObject({ event: "create_unresolved", commentId: "C_landed",
      issueNumber: value.plan.entries[0].canonicalIssueNumber, error: expect.stringContaining("disposition_history_unavailable:") });
    expect(result.ledgerRecords[0]).toMatchObject({ durableState: "unresolved_partial", result: { commentId: "C_landed" } });
    expect(result.failures).toMatchObject([{ stage: "dispatch", error: expect.stringContaining("disposition_history_unavailable:") }]);
    expect(indexHistory(journal.records).malformed).toEqual([]);
    expect(budget().count).toBe(0);
  });
});

describe("classification field receipts in the execution journal", () => {
  const actualStart = "2026-10-06T12:00:00.000Z";
  const receipt = {
    eventId: "IFAE_priority", eventCreatedAt: "2026-10-06T12:00:01Z",
    writeStartedAt: actualStart, readBackAt: "2026-10-06T12:00:03.000Z",
  };
  const classifications = [{ fieldName: "Type", value: "Feature" }, { fieldName: "Priority", value: "P2" },
    { fieldName: "Effort", value: "Medium" }] as const;
  const snapshot = { eventIds: new Set<string>(), currentValue: null };

  async function confirm(fields: ApprovalExecutionEvent["classifications"] = classifications, apply = true) {
    const path = resolveJournalPath(REPOSITORY);
    const oldEvent = intent(0, { event: "created", classifications: fields, issueNumber: 42, issueId: "I_42" });
    const claim = acquireExecutionClaim(path, { mode: "execute" });
    claim.withOwnership(() => appendJournal(path, oldEvent));
    const transport = {
      ...fixture().transport,
      snapshotFieldEvents: vi.fn(async (): Promise<FieldEventSnapshot | null> => snapshot),
      applyClassification: vi.fn(async (_repository: string, _number: number, field: { fieldName: string; value: string }) => {
        if (field.fieldName === "Priority") vi.setSystemTime(new Date("2026-10-06T12:00:01.000Z"));
        return {};
      }),
      readBackFieldWrite: vi.fn(async (_repository: string, _number: number,
        field: { fieldName: "Priority" | "Effort"; value: string; writeStartedAt: string }): Promise<typeof receipt | null> => {
        expect(transport.verifyClassifications).toHaveBeenCalledOnce();
        return field.fieldName === "Priority" ? { ...receipt, writeStartedAt: field.writeStartedAt } : null;
      }),
    };
    return {
      path, oldEvent, claim, transport,
      run: (currentTransport: OperatorIntakeApprovalTransport = transport) => confirmClassification({ transport: () => currentTransport, claim, fence: () => claim.withOwnership(() => {}),
        recordTransition: event => claim.withOwnership(() => appendJournal(path, event)),
        beforeWrite: () => assertNoDispositionBeforeWrite(eventWrite(oldEvent), { runGit: fakeGit, stableOutcomeId: "seed-outcome-0" }),
        write: eventWrite(oldEvent), identities: { issueNumber: 42, issueId: "I_42", commentId: null },
        apply, now: NOW, decisionContentSha256: oldEvent.decisionContentSha256 }),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(actualStart));
  });

  function liveTransport(options: {
    initialPriority?: string;
    removePriority?: "before-snapshot" | "before-write";
    extraEvent?: boolean;
    snapshotFailure?: boolean;
    fullPage?: "snapshot" | "read-back";
  } = {}) {
    const fields = [
      { id: 91, node_id: "IF_priority", name: "Priority", options: [{ id: 1, name: "P2" }] },
      { id: 92, node_id: "IF_effort", name: "Effort", options: [{ id: 2, name: "Medium" }] },
    ];
    const current = new Map<number, string>();
    const nodes: Record<string, unknown>[] = [];
    const trace: string[] = [];
    const event = (field: typeof fields[number], value: string, createdAt = "2026-10-06T12:00:00Z") => ({
      __typename: "IssueFieldAddedEvent", id: `event-${nodes.length}`, actor: { login: "filing-bot" }, createdAt,
      issueField: { id: field.node_id, fullDatabaseId: String(field.id), name: field.name }, options: [{ name: value }], value: null,
    });
    if (options.initialPriority) {
      current.set(91, options.initialPriority);
      nodes.push(event(fields[0], options.initialPriority, "2026-10-06T11:59:58Z"));
    }
    const removePriority = () => {
      nodes.push({
        __typename: "IssueFieldRemovedEvent", id: `event-${nodes.length}`, actor: { login: "human" },
        createdAt: "2026-10-06T11:59:59Z", issueField: event(fields[0], "P1").issueField,
        options: [{ name: current.get(91) }],
      });
      current.delete(91);
    };
    if (options.removePriority === "before-snapshot") removePriority();
    let writes = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/graphql") {
        const body = JSON.parse(String(init?.body));
        if (/viewer\s*\{/.test(body.query)) return Response.json({ data: { viewer: { login: "filing-bot" } } });
        trace.push("timeline");
        if (options.snapshotFailure && writes === 0) throw new Error("snapshot unavailable");
        const full = options.fullPage === (writes === 0 ? "snapshot" : "read-back");
        const visible = nodes.filter(node => node.__typename !== "IssueFieldRemovedEvent"
          || /itemTypes: \[[^\]]*ISSUE_FIELD_REMOVED_EVENT/.test(body.query));
        const page = full ? Array.from({ length: 100 }, (_, i) => ({ ...event(fields[1], "Low"), id: `old-${i}` })) : visible;
        return Response.json({ data: { repository: { issue: { timelineItems: { nodes: page } } } } });
      }
      if (path === "/orgs/example-org/issue-fields") return Response.json(fields);
      if (path === "/repos/example-org/example-repo/issues/42/issue-field-values") {
        if (init?.method === "POST") {
          const { field_id: id, value } = JSON.parse(String(init.body)).issue_field_values[0];
          const field = fields.find(field => field.id === id)!;
          trace.push(`write:${field.name}`);
          if (id === 91 && options.removePriority === "before-write" && writes === 0) removePriority();
          if (current.get(id) !== value) {
            if (options.extraEvent) nodes.push(event(field, "P1"));
            nodes.push(event(field, value));
          }
          current.set(id, value);
          writes += 1;
          return new Response(null, { status: 204 });
        }
        return Response.json(fields.filter(field => current.has(field.id)).map(field => ({
          issue_field_id: field.id, single_select_option: field.options.find(option => option.name === current.get(field.id)),
        })));
      }
      if (path === "/repos/example-org/example-repo/issues/42") return Response.json({ type: null });
      throw new Error(`Unexpected request ${path}`);
    });
    return { transport: createGitHubIntakeApprovalTransport({ token: "fixture-token", fetchImpl }), trace };
  }

  it.each([-5000, 250, 5000])("journals no receipt for a same-login human no-op with clock offset %s", async offset => {
    vi.setSystemTime(new Date(Date.parse(actualStart) + offset));
    const value = await confirm([classifications[1]]);
    try {
      const live = liveTransport({ initialPriority: "P2" });
      const complete = await value.run(live.transport);
      expect(complete.event).toBe("complete");
      expect(complete).not.toHaveProperty("fieldReceipts");
      expect(live.trace).toContain("write:Priority");
    } finally { value.claim.release(); }
  });

  it("journals no receipt when a human removes P1 between snapshot and filing's P2 add", async () => {
    const value = await confirm([classifications[1]]);
    try {
      const live = liveTransport({ initialPriority: "P1", removePriority: "before-write" });
      const complete = await value.run(live.transport);
      expect(complete.event).toBe("complete");
      expect(complete).not.toHaveProperty("fieldReceipts");
      expect(readJournal(value.path).records.at(-1)).not.toHaveProperty("fieldReceipts");
    } finally { value.claim.release(); }
  });

  it("journals the sole new add after a removal already present in the snapshot", async () => {
    const value = await confirm([classifications[1]]);
    try {
      const live = liveTransport({ initialPriority: "P2", removePriority: "before-snapshot" });
      const complete = await value.run(live.transport);
      expect(complete.event).toBe("complete");
      expect(complete.fieldReceipts).toEqual([
        expect.objectContaining({ field: "Priority", value: "P2", eventId: "event-2" }),
      ]);
      expect(readJournal(value.path).records.at(-1)).toMatchObject({ fieldReceipts: complete.fieldReceipts });
    } finally { value.claim.release(); }
  });

  it.each([0, 250])("receipts a write once and freshly snapshots a no-op rerun (millisecond=%s)", async milliseconds => {
    const start = new Date(Date.parse(actualStart) + milliseconds).toISOString();
    vi.setSystemTime(new Date(start));
    const value = await confirm([classifications[1]]);
    try {
      const live = liveTransport();
      expect((await value.run(live.transport)).fieldReceipts).toEqual([{
        field: "Priority", value: "P2", eventId: "event-0", eventCreatedAt: "2026-10-06T12:00:00Z",
        writeStartedAt: start, readBackAt: start,
      }]);
      const second = await value.run(live.transport);
      expect(second.event).toBe("complete");
      expect(second).not.toHaveProperty("fieldReceipts");
      expect(live.trace.filter(step => step === "write:Priority")).toHaveLength(2);
      expect(live.trace.slice(-2)).toEqual(["timeline", "write:Priority"]);
    } finally { value.claim.release(); }
  });

  it("recovers verification failure with a fresh snapshot and no receipt for the earlier write", async () => {
    const value = await confirm([classifications[1]]);
    try {
      const live = liveTransport();
      const verify = vi.spyOn(live.transport, "verifyClassifications").mockResolvedValueOnce(false);
      expect((await value.run(live.transport)).event).toBe("classification_failed");
      const recovered = await value.run(live.transport);
      expect(recovered.event).toBe("complete");
      expect(recovered).not.toHaveProperty("fieldReceipts");
      expect(verify).toHaveBeenCalledTimes(2);
      expect(live.trace).toEqual(["timeline", "write:Priority", "timeline", "write:Priority"]);
    } finally { value.claim.release(); }
  });

  it.each([
    { name: "a concurrent same-login event", extraEvent: true },
    { name: "a failed snapshot", snapshotFailure: true },
    { name: "a full snapshot page", fullPage: "snapshot" as const },
    { name: "a full read-back page", fullPage: "read-back" as const },
  ])("keeps the real transport write complete without a receipt for $name", async options => {
    const value = await confirm([classifications[1]]);
    try {
      const live = liveTransport(options);
      const complete = await value.run(live.transport);
      expect(complete.event).toBe("complete");
      expect(complete).not.toHaveProperty("fieldReceipts");
      expect(live.trace).toContain("write:Priority");
      expect(readJournal(value.path).records).not.toContainEqual(expect.objectContaining({ event: "classification_failed" }));
    } finally { value.claim.release(); }
  });

  it("separates Priority then Effort receipts through the real transport", async () => {
    const value = await confirm(classifications.slice(1));
    try {
      const live = liveTransport();
      expect((await value.run(live.transport)).fieldReceipts).toEqual([
        expect.objectContaining({ field: "Priority", value: "P2", eventId: "event-0" }),
        expect.objectContaining({ field: "Effort", value: "Medium", eventId: "event-1" }),
      ]);
      expect(live.trace).toEqual(["timeline", "write:Priority", "timeline", "write:Effort", "timeline", "timeline"]);
    } finally { value.claim.release(); }
  });

  it.each(["null", "throw"])("keeps a write complete when its snapshot returns %s", async failure => {
    const value = await confirm([classifications[1]]);
    if (failure === "null") value.transport.snapshotFieldEvents.mockResolvedValue(null);
    else value.transport.snapshotFieldEvents.mockRejectedValue(new Error("snapshot unavailable"));
    try {
      const complete = await value.run();
      expect(complete.event).toBe("complete");
      expect(complete).not.toHaveProperty("fieldReceipts");
      expect(value.transport.applyClassification).toHaveBeenCalledOnce();
      expect(value.transport.readBackFieldWrite).not.toHaveBeenCalled();
    } finally { value.claim.release(); }
  });

  it.each([false, true])("persists receipts through full apply (recovering=%s)", async recovering => {
    const value = fixture();
    if (recovering) {
      value.transport.verifyClassifications.mockResolvedValueOnce(false);
      expect((await applyIntakeApprovalPlan(value.input)).ledgerRecords[0].durableState).toBe("classification_failed");
    }
    const readBackFieldWrite = vi.fn(async (_repository: string, _number: number,
      field: { fieldName: "Priority" | "Effort"; value: string; writeStartedAt: string }) => ({
      ...receipt, eventId: `event-${field.fieldName}`, writeStartedAt: field.writeStartedAt,
    }));
    const transport = { ...value.transport, readBackFieldWrite, snapshotFieldEvents: vi.fn(async () => snapshot) };
    const result = await applyIntakeApprovalPlan({ ...value.input, transport });
    expect(result.failures).toEqual([]);
    expect(result.ledgerRecords[0].durableState).toBe("complete");
    expect(value.transport.createIssue).toHaveBeenCalledOnce();
    expect(result.writes[0].classifications).toContainEqual({ fieldName: "Effort", value: "Medium" });
    expect(readBackFieldWrite).toHaveBeenCalledExactlyOnceWith(REPOSITORY, 2101,
      { fieldName: "Effort", value: "Medium", writeStartedAt: actualStart, snapshot });
    expect(readJournal(resolveJournalPath(REPOSITORY)).records.at(-1)).toMatchObject({
      event: "complete", fieldReceipts: [
        { field: "Effort", value: "Medium", ...receipt, eventId: "event-Effort" },
      ],
    });
  });

  it("records verified writes separately from the recovery write inputs with a fresh start for each field", async () => {
    const value = await confirm();
    try {
      const complete = await value.run();
      expect(complete).toMatchObject({ event: "complete", appliedAt: NOW.toISOString(), classifications,
        fieldReceipts: [{ field: "Priority", value: "P2", ...receipt }] });
      expect(value.transport.readBackFieldWrite.mock.calls).toEqual([
        [REPOSITORY, 42, { fieldName: "Priority", value: "P2", writeStartedAt: actualStart, snapshot }],
        [REPOSITORY, 42, { fieldName: "Effort", value: "Medium", writeStartedAt: "2026-10-06T12:00:01.000Z", snapshot }],
      ]);
      expect(value.transport.snapshotFieldEvents.mock.calls).toEqual([
        [REPOSITORY, 42, "Priority"], [REPOSITORY, 42, "Effort"],
      ]);
      const snapshots = value.transport.snapshotFieldEvents.mock.invocationCallOrder;
      const writes = value.transport.applyClassification.mock.invocationCallOrder;
      expect(snapshots[0]).toBeLessThan(writes[1]);
      expect(snapshots[1]).toBeGreaterThan(writes[1]);
      expect(snapshots[1]).toBeLessThan(writes[2]);
      expect(complete.fieldReceipts).toHaveLength(1);
      expect(eventWrite(complete)).toEqual(eventWrite(value.oldEvent));
      const journal = readJournal(value.path);
      expect(journal.records).toEqual([value.oldEvent, complete]);
      expect(resolveDurableState(indexHistory(journal.records, journal.tail), value.oldEvent).kind).toBe("complete");
    } finally { value.claim.release(); }
  });

  it.each(["null", "throw"])("keeps a verified write complete with no receipt when read-back returns %s", async failure => {
    const value = await confirm([classifications[1]]);
    if (failure === "null") value.transport.readBackFieldWrite.mockResolvedValue(null);
    else value.transport.readBackFieldWrite.mockRejectedValue(new Error("timeline unavailable"));
    try {
      const complete = await value.run();
      expect(value.transport.applyClassification).toHaveBeenCalledOnce();
      expect(value.transport.readBackFieldWrite).toHaveBeenCalledOnce();
      expect(complete.event).toBe("complete");
      expect(complete).not.toHaveProperty("fieldReceipts");
      expect(readJournal(value.path).records).not.toContainEqual(expect.objectContaining({ event: "classification_failed" }));
    } finally { value.claim.release(); }
  });

  it("makes no receipt read for a Type-only write", async () => {
    const value = await confirm([classifications[0]]);
    try {
      const complete = await value.run();
      expect(value.transport.applyClassification).toHaveBeenCalledOnce();
      expect(complete.event).toBe("complete");
      expect(complete).not.toHaveProperty("fieldReceipts");
      expect(value.transport.readBackFieldWrite).not.toHaveBeenCalled();
      expect(value.transport.snapshotFieldEvents).not.toHaveBeenCalled();
    } finally { value.claim.release(); }
  });

  it("does not claim a past write when only verifying without applying", async () => {
    const value = await confirm(classifications, false);
    try {
      expect(await value.run()).toMatchObject({ event: "complete" });
      expect(value.transport.applyClassification).not.toHaveBeenCalled();
      expect(value.transport.readBackFieldWrite).not.toHaveBeenCalled();
      expect(readJournal(value.path).records.at(-1)).not.toHaveProperty("fieldReceipts");
    } finally { value.claim.release(); }
  });

  it("does not read receipts when classification verification fails", async () => {
    const value = await confirm();
    value.transport.verifyClassifications.mockResolvedValue(false);
    try {
      expect(await value.run()).toMatchObject({ event: "classification_failed" });
      expect(value.transport.readBackFieldWrite).not.toHaveBeenCalled();
    } finally { value.claim.release(); }
  });

  it("parses and recovers an old journal event without receipts without changing its stored bytes", async () => {
    const value = fixture();
    value.transport.verifyClassifications.mockResolvedValueOnce(false);
    expect((await applyIntakeApprovalPlan(value.input)).ledgerRecords[0].durableState).toBe("classification_failed");
    const path = resolveJournalPath(REPOSITORY);
    const before = readFileSync(path);
    const journal = readJournal(path);
    for (const row of journal.records) expect(row).not.toHaveProperty("fieldReceipts");
    const failed = journal.records.at(-1) as ApprovalExecutionEvent;
    expect(resolveDurableState(indexHistory(journal.records, journal.tail), failed).kind).toBe("classification_failed");
    const result = await applyIntakeApprovalPlan(value.input);
    expect(result.failures).toEqual([]);
    expect(result.ledgerRecords[0].durableState).toBe("complete");
    expect(value.transport.createIssue).toHaveBeenCalledOnce();
    expect(readFileSync(path).subarray(0, before.length)).toEqual(before);
    const complete = readJournal(path).records.at(-1) as ApprovalExecutionEvent;
    expect(complete).not.toHaveProperty("fieldReceipts");
    expect(eventWrite(complete)).toEqual(eventWrite(failed));
  });
});

describe("repository create damage budget", () => {
  it("keys append history by emission, preserves old rows, and replays either completed comment", async () => {
    const first = fixture(1, "first-evidence", true);
    const second = fixture(1, "second-evidence", true);
    expect(first.envelope.candidates[0].sourceFingerprint).toBe(second.envelope.candidates[0].sourceFingerprint);
    expect(first.envelope.candidates[0].emissionContentSha256).not.toBe(second.envelope.candidates[0].emissionContentSha256);
    first.transport.appendEvidenceComment.mockResolvedValue({ commentId: "C_first" });
    second.transport.appendEvidenceComment.mockResolvedValue({ commentId: "C_second" });
    expect((await applyIntakeApprovalPlan(first.input)).ledgerRecords[0].durableState).toBe("complete");
    const path = resolveJournalPath(REPOSITORY);
    const originalRows = readJournal(path).records;
    expect((await applyIntakeApprovalPlan(second.input)).ledgerRecords[0].durableState).toBe("complete");
    expect(readJournal(path).records.slice(0, originalRows.length)).toEqual(originalRows);
    expect(first.transport.appendEvidenceComment).toHaveBeenCalledOnce();
    expect(second.transport.appendEvidenceComment).toHaveBeenCalledOnce();
    expect(budget().count).toBe(0);
    for (const value of [first, second]) {
      value.openTransport.mockClear();
      for (const method of Object.values(value.transport)) method.mockClear();
      const result = await applyIntakeApprovalPlan(value.input);
      expect(result.ledgerRecords[0]).toMatchObject({ durableState: "complete", result: {
        issueNumber: 7, commentId: value === first ? "C_first" : "C_second",
      } });
      untouched(value);
    }
  });

  it.each([
    { submitted: "A", sibling: "classification_failed" },
    { submitted: "B", sibling: "classification_failed" },
    { submitted: "A", sibling: "abandoned" },
  ] as const)("limits null-action replay $submitted to its own operation with sibling $sibling", async ({ submitted, sibling }) => {
    const first = fixture(1, "A", true);
    const second = fixture(1, "B", true);
    first.transport.appendEvidenceComment.mockResolvedValue({ commentId: "C_A" });
    second.transport.appendEvidenceComment.mockResolvedValue({ commentId: "C_B" });
    await applyIntakeApprovalPlan(first.input);
    const path = resolveJournalPath(REPOSITORY);
    if (sibling === "classification_failed") {
      second.transport.verifyClassifications.mockResolvedValue(false);
      expect((await applyIntakeApprovalPlan(second.input)).ledgerRecords[0].durableState).toBe("classification_failed");
    } else {
      const preview = await applyIntakeApprovalPlan({ ...second.input, execute: false });
      const claim = acquireExecutionClaim(path, { mode: "execute" });
      try {
        const pending = executionEvent({ event: "intent", now: NOW, write: preview.writes[0],
          decisionContentSha256: second.plan.entries[0].decisionReport.contentSha256 });
        claim.withOwnership(() => appendJournal(path, pending));
        claim.withOwnership(() => appendJournal(path, { ...pending, event: "abandoned", abandonment: {
          reason: "Stop B", operator: "test", priorState: "intent_unknown", priorEventRowNumber: readJournal(path).records.length,
          at: NOW.toISOString(),
        } }));
      } finally { claim.release(); }
    }
    const before = readJournal(path).records;
    const replay = fixture(1, submitted, true, true);
    const result = await applyIntakeApprovalPlan(replay.input);
    expect(result.ledgerRecords[0]).toMatchObject({ durableState: "complete", result: { issueNumber: 7, commentId: `C_${submitted}` } });
    expect(result.failures).toEqual([]);
    expect(readJournal(path).records.slice(0, before.length)).toEqual(before);
    if (submitted === "A") {
      untouched(replay);
      expect(readJournal(path).records).toEqual(before);
    } else {
      expect(replay.transport.verifyClassifications).toHaveBeenCalledOnce();
      expect(readJournal(path).records.slice(before.length)).toEqual([expect.objectContaining({ event: "complete",
        emissionContentSha256: replay.envelope.candidates[0].emissionContentSha256, commentId: "C_B" })]);
    }
    expect(replay.transport.createIssue).not.toHaveBeenCalled();
    expect(replay.transport.appendEvidenceComment).not.toHaveBeenCalled();
  });

  it.each(["abandoned sibling", "legacy", "conflict", "unresolved create"] as const)(
    "refuses marker recovery before transport with %s history", async (barrier) => {
      const pending = fixture(1, "pending-replay", true);
      pending.transport.verifyClassifications.mockResolvedValue(false);
      expect((await applyIntakeApprovalPlan(pending.input)).ledgerRecords[0].durableState).toBe("classification_failed");
      const path = resolveJournalPath(REPOSITORY);
      const failed = readJournal(path).records.at(-1) as ApprovalExecutionEvent;
      const claim = acquireExecutionClaim(path, { mode: "execute" });
      try {
        if (barrier === "abandoned sibling") {
          const sibling = { ...failed, event: "intent", emissionContentSha256: "f".repeat(64), issueNumber: null,
            issueId: null, commentId: null, error: undefined };
          claim.withOwnership(() => appendJournal(path, sibling));
          claim.withOwnership(() => appendJournal(path, { ...sibling, event: "abandoned", abandonment: {
            reason: "Stop sibling", operator: "test", priorState: "intent_unknown",
            priorEventRowNumber: readJournal(path).records.length, at: NOW.toISOString(),
          } }));
        } else if (barrier === "legacy") {
          claim.withOwnership(() => appendJournal(path, { mode: "execute", executed: true, repository: REPOSITORY,
            sourceFingerprint: failed.sourceFingerprint, actionTaken: "create_issue", appliedAt: NOW.toISOString(),
            result: { issueNumber: 7 } }));
        } else if (barrier === "conflict") {
          claim.withOwnership(() => appendJournal(path, { ...failed, issueNumber: 8 }));
        } else {
          claim.withOwnership(() => appendJournal(path, intent(0, { sourceFingerprint: failed.sourceFingerprint })));
        }
      } finally { claim.release(); }
      const before = readFileSync(path);
      const replay = fixture(1, "pending-replay", true, true);
      const result = await applyIntakeApprovalPlan(replay.input);
      expect(result.ledgerRecords[0].disposition).toBe("refused");
      expect(result.ledgerRecords[0].durableState).not.toBe("complete");
      untouched(replay);
      expect(readFileSync(path)).toEqual(before);
    },
  );

  it.each(["intent", "abandoned"] as const)("keeps creates available after a completed append and another emission's %s", async (event) => {
    const first = fixture(1, "completed-evidence", true);
    const second = fixture(1, "unfinished-evidence", true);
    expect((await applyIntakeApprovalPlan(first.input)).ledgerRecords[0].durableState).toBe("complete");
    const preview = await applyIntakeApprovalPlan({ ...second.input, execute: false });
    const path = resolveJournalPath(REPOSITORY);
    const claim = acquireExecutionClaim(path, { mode: "execute" });
    try {
      const pending = executionEvent({ event: "intent", now: NOW, write: preview.writes[0],
        decisionContentSha256: second.plan.entries[0].decisionReport.contentSha256 });
      claim.withOwnership(() => appendJournal(path, pending));
      if (event === "abandoned") claim.withOwnership(() => appendJournal(path, { ...pending, event: "abandoned",
        abandonment: { reason: "Stop second emission", operator: "test", priorState: "intent_unknown",
          priorEventRowNumber: readJournal(path).records.length, at: NOW.toISOString() } }));
    } finally { claim.release(); }
    expect(budget().problem).toBeUndefined();
    expect(budget().count).toBe(0);
    const create = fixture(1, "unrelated-create");
    expect((await applyIntakeApprovalPlan(create.input)).ledgerRecords[0].durableState).toBe("complete");
    expect(create.transport.createIssue).toHaveBeenCalledOnce();
    expect(budget().count).toBe(1);
    const later = fixture(1, "later-evidence", true);
    const replay = await applyIntakeApprovalPlan(later.input);
    expect(replay.ledgerRecords[0].durableState).toBe(event === "intent" ? "intent_unknown" : "abandoned");
    untouched(later);
  });

  it.each(["two unfinished appends", "append timestamp", "append/create legacy conflict", "create contract conflict"])(
    "retains the repository budget barrier for %s", async (kind) => {
      const append = intent(0, { action: "append_evidence",
        payload: { issue: null, evidenceComment: "Evidence", closeIssue: null } });
      const complete = { ...append, event: "complete", issueNumber: 7, commentId: "C_first" };
      const pending = { ...append, emissionContentSha256: "c".repeat(64) };
      const rows = kind === "two unfinished appends" ? [append, pending]
        : kind === "append timestamp" ? [complete, { ...pending, appliedAt: "2026-09-17T12:00:00" }]
        : kind === "append/create legacy conflict" ? [complete, pending, {
          mode: "execute", executed: true, repository: REPOSITORY, sourceFingerprint: append.sourceFingerprint,
          actionTaken: "create_issue", appliedAt: NOW.toISOString(), result: { issueNumber: 7 },
        }]
        : [intent(), intent(0, { emissionContentSha256: "c".repeat(64) })];
      const path = resolveJournalPath(REPOSITORY);
      const claim = acquireExecutionClaim(path, { mode: "execute" });
      try { for (const row of rows) claim.withOwnership(() => appendJournal(path, row)); }
      finally { claim.release(); }
      expect(budget().problem).toBeDefined();
      const before = readFileSync(path);
      const create = fixture(1, "unrelated-create");
      const result = await applyIntakeApprovalPlan({ ...create.input, immediate: false, allowCreateBudgetOverrun: true });
      expect(result.ledgerRecords[0].refusalReason).toContain("repository_create_budget_unavailable:");
      untouched(create);
      expect(readFileSync(path)).toEqual(before);
    },
  );

  it("keeps create identity independent of emission", async () => {
    const value = fixture();
    await applyIntakeApprovalPlan(value.input);
    const journal = readJournal(resolveJournalPath(REPOSITORY));
    expect(resolveDurableState(indexHistory(journal.records, journal.tail), {
      repository: REPOSITORY, sourceFingerprint: value.envelope.candidates[0].sourceFingerprint,
      action: "create_issue", emissionContentSha256: "f".repeat(64),
    }).kind).toBe("complete");
  });

  it.each([
    { event: "intent", state: "intent_unknown", confirmed: false },
    { event: "created", state: "primary_unverified", confirmed: true },
    { event: "classification_failed", state: "classification_failed", confirmed: true },
    { event: "create_unresolved", state: "unresolved_unknown", confirmed: false },
    { event: "create_unresolved", state: "unresolved_partial", confirmed: true },
  ] as const)("does not bypass or recover another emission's $state append", async ({ event, state, confirmed }) => {
    const first = fixture(1, "unsafe-evidence", true);
    const second = fixture(1, "new-evidence", true);
    const preview = await applyIntakeApprovalPlan({ ...first.input, execute: false });
    const path = resolveJournalPath(REPOSITORY);
    const claim = acquireExecutionClaim(path, { mode: "execute" });
    try {
      claim.withOwnership(() => appendJournal(path, executionEvent({
        event, now: NOW, write: preview.writes[0], decisionContentSha256: first.plan.entries[0].decisionReport.contentSha256,
        ...(confirmed ? { issueNumber: 7, commentId: "C_unverified" } : {}),
      })));
    } finally { claim.release(); }
    const before = readFileSync(path);
    const result = await applyIntakeApprovalPlan(second.input);
    expect(result.ledgerRecords[0].durableState).toBe(state);
    untouched(second);
    expect(readFileSync(path)).toEqual(before);
  });

  it.each([false, true])("borrows the caller's real claim without releasing it (transport failure=%s)", async fails => {
    const value = fixture();
    const path = resolveJournalPath(REPOSITORY);
    const heldClaim = acquireExecutionClaim(path, { mode: "execute" });
    const ownerPath = join(dirname(path), "execution.lock", "owner.json");
    const before = readFileSync(ownerPath);
    if (fails) value.transport.createIssue.mockRejectedValue(new Error("lost response"));
    try {
      const result = await runIntakeApplyCli({ argv: value.cliArgs, repoRoot: value.root, runGit: fakeGit,
        operatorToken: "fixture-token", openTransport: value.openTransport, heldClaim, log: () => {} });
      expect(result.ledgerRecords[0].durableState).toBe(fails ? "unresolved_unknown" : "complete");
      expect(value.transport.createIssue).toHaveBeenCalledOnce();
      expect(readFileSync(ownerPath)).toEqual(before);
      expect(heldClaim.withOwnership(() => true)).toBe(true);
    } finally { heldClaim.release(); }
    const next = acquireExecutionClaim(path, { mode: "execute" });
    next.release();
  });

  it("standalone apply releases the claim it acquired", async () => {
    const value = fixture();
    const path = resolveJournalPath(REPOSITORY);
    value.transport.createIssue.mockImplementation(async () => {
      expect(() => acquireExecutionClaim(path, { mode: "execute" })).toThrow(/held by pid/);
      return { issueNumber: 2101, issueId: "I_2101" };
    });
    await applyIntakeApprovalPlan(value.input);
    const next = acquireExecutionClaim(path, { mode: "execute" });
    next.release();
  });

  it("allows the first immediate create and refuses its second with a named invocation bound", async () => {
    const value = fixture(2);
    const result = await applyIntakeApprovalPlan(value.input);
    expect(result.ledgerRecords[0].durableState).toBe("complete");
    expect(result.ledgerRecords[1]).toMatchObject({ disposition: "refused", executed: false,
      refusalReason: expect.stringContaining("immediate_create_limit_exhausted: window=invocation; count=1; ceiling=1") });
    expect(value.transport.createIssue).toHaveBeenCalledOnce();
    expect(value.transport.preflightClassifications.mock.calls[0][0]).toHaveLength(1);
    expect(budget().count).toBe(1);
  });

  it("refuses an exhausted repository before opening or calling any transport and leaves bytes intact", async () => {
    const value = fixture();
    seed(INTAKE_CREATE_LIMITS.repositoryCreates);
    const before = readFileSync(resolveJournalPath(REPOSITORY));
    const result = await applyIntakeApprovalPlan(value.input);
    expect(result.ledgerRecords[0].refusalReason).toContain("repository_create_budget_exhausted: window=rolling 24h");
    expect(result.ledgerRecords[0].refusalReason).toContain(`count=${INTAKE_CREATE_LIMITS.repositoryCreates}; ceiling=${INTAKE_CREATE_LIMITS.repositoryCreates}`);
    untouched(value);
    expect(readFileSync(resolveJournalPath(REPOSITORY))).toEqual(before);
  });

  it("lets replay succeed at exhaustion without a charge or transport", async () => {
    const value = fixture();
    await applyIntakeApprovalPlan(value.input);
    seed(INTAKE_CREATE_LIMITS.repositoryCreates - 1);
    const before = readFileSync(resolveJournalPath(REPOSITORY));
    value.openTransport.mockClear();
    for (const method of Object.values(value.transport)) method.mockClear();
    const result = await applyIntakeApprovalPlan(value.input);
    expect(result.ledgerRecords[0]).toMatchObject({ durableState: "complete", executed: true });
    expect(budget().count).toBe(INTAKE_CREATE_LIMITS.repositoryCreates);
    expect(readFileSync(resolveJournalPath(REPOSITORY))).toEqual(before);
    untouched(value);
  });

  it.each(["intent", "create_unresolved", "classification_failed"] as const)("recovery of %s never creates or adds a charge at exhaustion", async (event) => {
    const value = fixture();
    const preview = await applyIntakeApprovalPlan({ ...value.input, execute: false });
    const first = executionEvent({ event: "intent", now: NOW, write: preview.writes[0], decisionContentSha256: value.plan.decision.contentSha256 });
    const path = resolveJournalPath(REPOSITORY);
    seed(INTAKE_CREATE_LIMITS.repositoryCreates - 1);
    appendJournal(path, first);
    if (event !== "intent") appendJournal(path, { ...first, event, issueNumber: event === "classification_failed" ? 2101 : null, issueId: "I_2101" });
    const result = await applyIntakeApprovalPlan(value.input);
    expect(value.transport.createIssue).not.toHaveBeenCalled();
    expect(budget().count).toBe(INTAKE_CREATE_LIMITS.repositoryCreates);
    expect((readJournal(path).records as ApprovalExecutionEvent[]).filter((row) => row.event === "intent")).toHaveLength(INTAKE_CREATE_LIMITS.repositoryCreates);
    expect(result.ledgerRecords[0].durableState).toBe(event === "classification_failed" ? "complete" : event === "intent" ? "unresolved_unknown" : "unresolved_partial");
  });

  it("records explicit supervised overrun on every create intent, and batches consume the same budget", async () => {
    const value = fixture(2);
    seed(INTAKE_CREATE_LIMITS.repositoryCreates, new Date());
    const result = await runIntakeApplyCli({ argv: [...value.cliArgs, "--allow-create-budget-overrun"],
      repoRoot: value.root, runGit: fakeGit, openTransport: value.openTransport, operatorToken: "test-token", log: () => {} });
    expect(result.ledgerRecords.every((row) => row.durableState === "complete")).toBe(true);
    expect(budget(new Date()).count).toBe(INTAKE_CREATE_LIMITS.repositoryCreates + 2);
    const rows = readJournal(resolveJournalPath(REPOSITORY)).records as ApprovalExecutionEvent[];
    expect(rows.filter((row) => row.createBudgetOverride !== undefined).map((row) => row.createBudgetOverride)).toEqual([INTAKE_CREATE_LIMITS.repositoryCreates, INTAKE_CREATE_LIMITS.repositoryCreates + 1].map((countBefore) => ({
      flag: "--allow-create-budget-overrun", operator: expect.any(String), runId: "first", countBefore,
      ceiling: INTAKE_CREATE_LIMITS.repositoryCreates, windowHours: 24, windowStart: expect.any(String), at: expect.any(String),
    })));
    const immediate = fixture(1, "after-batch");
    const refused = await applyIntakeApprovalPlan({ ...immediate.input, now: new Date() });
    expect(refused.ledgerRecords[0].refusalReason).toContain(`count=${INTAKE_CREATE_LIMITS.repositoryCreates + 2}`);
    untouched(immediate);
  });

  it("enforces the repository budget on a supervised batch by default", async () => {
    const value = fixture(2);
    seed(INTAKE_CREATE_LIMITS.repositoryCreates - 1);
    const result = await applyIntakeApprovalPlan({ ...value.input, immediate: false });
    expect(value.transport.createIssue).toHaveBeenCalledOnce();
    expect(result.ledgerRecords[1].refusalReason).toContain("repository_create_budget_exhausted");
    expect(budget().count).toBe(INTAKE_CREATE_LIMITS.repositoryCreates);
  });

  it("rejects an immediate override before transport", async () => {
    const value = fixture();
    await expect(applyIntakeApprovalPlan({ ...value.input, allowCreateBudgetOverrun: true })).rejects.toThrow("immediate filing cannot override");
    untouched(value);
  });

  it("dry-runs an exhausted budget with its intended payload and no charge or refusal", async () => {
    const value = fixture(2);
    seed(INTAKE_CREATE_LIMITS.repositoryCreates);
    const before = readFileSync(resolveJournalPath(REPOSITORY));
    const log = vi.fn();
    const result = await runIntakeApplyCli({ argv: [`--plan=${value.input.planPath}`], immediate: true,
      openTransport: value.openTransport, log });
    expect(result.writes).toHaveLength(2);
    expect(log.mock.calls[0][0]).toContain(JSON.stringify(value.plan.entries[0].issue!.body));
    expect(result.ledgerRecords.every((row) => row.refusalReason === undefined)).toBe(true);
    expect(result.failures).toEqual([]);
    expect(readFileSync(resolveJournalPath(REPOSITORY))).toEqual(before);
    untouched(value);
  });

  it.each(["malformed", "tail", "timestamp"])("refuses an indeterminate %s budget even with an operator override", async (kind) => {
    const value = fixture();
    const path = resolveJournalPath(REPOSITORY);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, kind === "malformed" ? `${JSON.stringify({ ...intent(), event: "invalid" })}\n` : kind === "tail" ? JSON.stringify(intent())
      : `${JSON.stringify(intent(0, { appliedAt: "unknown" }))}\n`);
    const result = await applyIntakeApprovalPlan({ ...value.input, immediate: false, allowCreateBudgetOverrun: true });
    expect(result.ledgerRecords[0].refusalReason).toContain("repository_create_budget_unavailable");
    untouched(value);
  });

  it("ages the first intent only, deduplicates folded identity, and keeps future attempts charged", () => {
    const old = intent(0, { appliedAt: "2026-09-16T12:00:00.000Z" });
    const current = intent(1);
    const rows = [old, { ...old, event: "create_unresolved", appliedAt: NOW.toISOString() }, current,
      { ...current, repository: "example-org/example-repo" }, intent(2, { appliedAt: "2026-09-18T12:00:00.000Z" }),
      intent(3, { action: "append_evidence" }), intent(4, { repository: "another/repository" })];
    const derived = deriveRepositoryCreateBudget(indexHistory(rows), REPOSITORY, NOW);
    expect(derived.count).toBe(2);
    expect(derived.problem).toBeUndefined();
    expect(indexHistory(rows).staged.size).toBe(5); // ageing did not erase ownership.
  });

  it("uses original legacy operation time rather than import time, deduplicating repeated imports", () => {
    const row = { mode: "execute", executed: true, sourceFingerprint: "legacy", actionTaken: "create_issue",
      appliedAt: "2026-09-12T18:29:59.709Z", result: { issueNumber: 1777 } };
    const imported = { kind: "legacy_import", importedAt: NOW.toISOString(), importedFrom: "legacy.jsonl", row };
    expect(deriveRepositoryCreateBudget(indexHistory([imported, imported]), REPOSITORY, NOW).count).toBe(0);
    expect(deriveRepositoryCreateBudget(indexHistory([imported, imported]), REPOSITORY, new Date(row.appliedAt)).count).toBe(1);
  });

  it("refuses conflicting cross-format identities instead of ageing a fresh attempt against another issue", () => {
    const current = intent(0, { event: "complete", issueNumber: 2101 });
    const legacy = { mode: "execute", executed: true, sourceFingerprint: current.sourceFingerprint,
      actionTaken: "create_issue", appliedAt: "2026-09-12T18:29:59.709Z", result: { issueNumber: 1777 } };
    expect(deriveRepositoryCreateBudget(indexHistory([current, legacy]), REPOSITORY, NOW).problem)
      .toBe("Conflicting repository create identity.");
  });

  it("ages a completed charge out without erasing ownership or permitting a second create", async () => {
    const value = fixture();
    await applyIntakeApprovalPlan(value.input);
    const later = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    expect(budget(later).count).toBe(0);
    value.openTransport.mockClear();
    for (const method of Object.values(value.transport)) method.mockClear();
    const replay = await applyIntakeApprovalPlan({ ...value.input, now: later });
    expect(replay.ledgerRecords[0].durableState).toBe("complete");
    untouched(value);
  });
});

// Separate Node processes exercise a restart and the actual filesystem claim. They
// execute the full apply path with a local transport; no GitHub credential or HTTP.
function childRun(value: ReturnType<typeof fixture>, pause = false) {
  const inputPath = join(value.root, "child-input.json");
  writeFileSync(inputPath, JSON.stringify(value.input));
  const runnerPath = join(value.root, "child-run.ts");
  writeFileSync(runnerPath, `
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { applyIntakeApprovalPlan } from ${JSON.stringify(resolve("scripts/github-issue-roadmap-intake-apply.ts"))};
const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
let creates = 0;
const transport = {
  preflightClassifications: async () => {},
  createIssue: async () => {
    creates++;
    if (process.argv[3] === "pause") {
      process.stdout.write("RESERVED\\n");
      await new Promise(resolve => process.stdin.once("data", resolve));
      process.stdin.pause();
    }
    const issueNumber = parseInt(createHash("sha256").update(input.planPath).digest("hex").slice(0, 8), 16) + creates;
    return { issueNumber, issueId: "I_" + issueNumber };
  },
  appendEvidenceComment: async () => ({ commentId: "C_1" }), closeIssue: async () => {},
  applyClassification: async () => ({}), verifyClassifications: async () => true,
};
applyIntakeApprovalPlan({ ...input, now: new Date(input.now), transport,
  runGit: (_cwd, args) => args.includes("--is-shallow-repository") ? "false" : args[0] === "rev-parse" ? args[2] === "origin/main^{commit}" ? input.trustedCurrentOriginMainSha : args[2].replace("^{commit}", "") : "",
}).then(result => process.stdout.write(JSON.stringify({ creates, result }) + "\\n"))
  .catch(error => process.stdout.write(JSON.stringify({ creates, error: error.message }) + "\\n"));
`);
  const child = spawn(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), runnerPath, inputPath, ...(pause ? ["pause"] : [])],
    { cwd: process.cwd(), env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let output = "";
  let errors = "";
  let onReserved!: () => void;
  const reserved = new Promise<void>((resolve) => { onReserved = resolve; });
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.includes("RESERVED\n")) onReserved(); });
  child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
  const done = new Promise<{ creates: number; result?: IntakeApplyResult; error?: string }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", () => {
      try { resolve(JSON.parse(output.trim().split("\n").at(-1)!)); }
      catch { reject(new Error(`Child did not report a result: ${output}\n${errors}`)); }
    });
  });
  return { child, reserved, done };
}

describe("durable quota across processes", () => {
  it("derives the same count after a restart between two invocations", async () => {
    const first = fixture();
    const second = fixture(1, "second");
    expect((await childRun(first).done).creates).toBe(1);
    expect(budget().count).toBe(1);
    expect((await childRun(second).done).creates).toBe(1);
    expect(budget().count).toBe(2);
  }, 20_000);

  it("prevents two processes consuming the last unit through the real claim", async () => {
    const first = fixture();
    const second = fixture(1, "second");
    seed(INTAKE_CREATE_LIMITS.repositoryCreates - 1);
    const running = childRun(first, true);
    try {
      await Promise.race([running.reserved, running.done.then((result) => { throw new Error(`First child exited before reserving: ${JSON.stringify(result)}`); })]);
      expect(budget().count).toBe(INTAKE_CREATE_LIMITS.repositoryCreates); // fsynced before the pending create returns.
      const contender = await childRun(second).done;
      expect(contender).toMatchObject({ creates: 0, error: expect.stringContaining("Execution journal claim refused") });
      running.child.stdin.write("finish\n");
      expect((await running.done).creates).toBe(1);
      const retry = await childRun(second).done;
      expect(retry.creates).toBe(0);
      expect(retry.result!.ledgerRecords[0].refusalReason).toContain("repository_create_budget_exhausted");
      expect(budget().count).toBe(INTAKE_CREATE_LIMITS.repositoryCreates);
    } finally { running.child.kill(); }
  }, 20_000);
});
