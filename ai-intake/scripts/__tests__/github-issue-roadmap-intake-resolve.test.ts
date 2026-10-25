import { existsSync, fsyncSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runIntakeResolveCli } from "../github-issue-roadmap-intake-resolve";
import { assertNoDispositionBeforeWrite, eventWrite, executionEvent, indexHistory, projectResult, reconcileCreate, resolveDurableState,
  type Abandonment, type LegacyVerifiedExecutionEvent } from "../github-issue-roadmap-intake-apply";
import { acquireExecutionClaim, appendJournal, importLegacyLedgers, readJournal, resolveJournalPath } from "../lib/github-issue-roadmap/intake-execution-journal";
import { canonicalJsonSha256, sha256Bytes } from "../lib/github-issue-roadmap/canonical-json";
import { intakeSnapshotCoverageSha256 } from "../lib/github-issue-roadmap/intake-assessment";
import { parseIntakeSnapshotV1, type IntakeSnapshotV1 } from "../lib/github-issue-roadmap/intake-snapshot";
import type { OwnershipLiveIssue, OwnershipRefusalReason } from "../lib/github-issue-roadmap/intake-create-reconciliation";
import { createGitHubIntakeApprovalTransport } from "../lib/github-issue-roadmap/github-intake-approval-transport";
import type { ObservedClassification } from "../lib/github-issue-roadmap/intake-legacy-verification";
import { dispositionHistory } from "../lib/github-issue-roadmap/disposition-history";
import { createOutcomeEnvelope, OUTCOME_ENVELOPE_SCHEMA_VERSION_V2 } from "../lib/github-issue-roadmap/outcome-candidate";
import { parseSourceMarker, SOURCE_MARKER } from "../lib/github-issue-roadmap/source-marker";
import { stackEnvelope } from "./__helpers__/roadmap-intake-stack";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync), fsyncSync: vi.fn(fs.fsyncSync) };
});

const REPOSITORY = "Owner/repo";
const FINGERPRINT = "f".repeat(64);
const FIRST = "2026-09-01T12:00:00.000Z";
const NOW = new Date("2026-09-15T12:00:00.000Z");
const IDENTITY = { repository: REPOSITORY, sourceFingerprint: FINGERPRINT, action: "create_issue" as const };
const RESULT = { issueNumber: 101, issueId: "I_101", commentId: "IC_101" };
const REASON = "Operator stopped pursuing this operation.";
let root: string;
let journalPath: string;
let lockPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "roadmap-resolve-"));
  vi.stubEnv("ROADMAP_INTAKE_JOURNAL_ROOT", root);
  journalPath = resolveJournalPath(REPOSITORY);
  lockPath = join(dirname(journalPath), "execution.lock");
});
afterEach(() => {
  vi.mocked(readFileSync).mockReset();
  vi.mocked(fsyncSync).mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function event(name: string, overrides: Record<string, unknown> = {}) {
  return { schemaVersion: "github-issue-roadmap-intake-approval-ledger/v1", event: name,
    appliedAt: FIRST, ...IDENTITY,
    emissionContentSha256: "e".repeat(64), decisionContentSha256: "d".repeat(64),
    payload: { issue: { title: "Title", body: "Body" }, evidenceComment: null, closeIssue: null },
    classifications: [{ fieldName: "Priority", value: "P2" }],
    issueNumber: null, issueId: null, commentId: null, ...overrides };
}

function legacy(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: "github-issue-roadmap-intake-approval-ledger/v1", appliedAt: FIRST,
    repository: REPOSITORY, sourceFingerprint: FINGERPRINT, actionTaken: "create_issue", mode: "execute", executed: true,
    decisionContentSha256: "d".repeat(64), result: RESULT,
    operatorFinalClassification: [{ fieldName: "Priority", value: "P2" }], ...overrides };
}

const ALLOWED = [
  { kind: "intent_unknown", rows: () => [event("intent")], result: { issueNumber: null, issueId: null, commentId: null } },
  { kind: "primary_unverified", rows: () => [event("created", RESULT)], result: RESULT },
  { kind: "classification_failed", rows: () => [event("classification_failed", RESULT)], result: RESULT },
  { kind: "unresolved_unknown", rows: () => [event("create_unresolved")], result: { issueNumber: null, issueId: null, commentId: null } },
  { kind: "unresolved_partial", rows: () => [event("created", RESULT), event("create_unresolved")], result: RESULT },
  { kind: "legacy_unverified", rows: () => [legacy()], result: RESULT },
] as const;

function abandoned(priorState: Abandonment["priorState"] = "unresolved_unknown", overrides: Record<string, unknown> = {}) {
  return event("abandoned", { appliedAt: NOW.toISOString(), abandonment: { reason: REASON, operator: "operator",
    priorState, priorEventRowNumber: 1, at: NOW.toISOString() }, ...overrides });
}

function persist(rows: readonly unknown[]) {
  mkdirSync(dirname(journalPath), { recursive: true });
  writeFileSync(journalPath, rows.map((row) => JSON.stringify(row) + "\n").join(""));
}

function state() {
  const journal = readJournal(journalPath);
  return resolveDurableState(indexHistory(journal.records, journal.tail), IDENTITY);
}

function cli(argv: readonly string[]) {
  const log = vi.fn();
  const error = vi.fn();
  const code = runIntakeResolveCli({ argv, now: NOW, log, error });
  return { code, stdout: log.mock.calls.map(([line]) => line).join("\n"), stderr: error.mock.calls.map(([line]) => line).join("\n") };
}

function abandon(expected = "unresolved_unknown", flags: readonly string[] = ["--execute"]) {
  return cli(["abandon", `--repository=${REPOSITORY}`, `--source-fingerprint=${FINGERPRINT}`,
    "--action=create_issue", `--expected-state=${expected}`, `--reason=${REASON}`, ...flags]);
}

describe("abandoned durable state", () => {
  it.each(ALLOWED)("resolves abandonment after $kind and preserves the prior journal bytes", ({ kind, rows, result }) => {
    const before = rows();
    persist([...before, abandoned(kind, { ...result, abandonment: { reason: REASON, operator: "operator",
      priorState: kind, priorEventRowNumber: before.length, at: NOW.toISOString() } })]);
    expect(state()).toMatchObject({ kind: "abandoned", operation: { result, event: { abandonment: { priorState: kind, reason: REASON } } } });
    expect(readJournal(journalPath).records.slice(0, before.length)).toEqual(before);
  });

  it.each(["intent", "created", "complete", "classification_failed", "create_unresolved", "abandoned"])("a later %s cannot reopen abandonment, even with a changed emission", (name) => {
    persist([event("create_unresolved"), abandoned(), name === "abandoned" ? abandoned() : event(name, {
      ...RESULT, emissionContentSha256: "a".repeat(64), decisionContentSha256: "b".repeat(64),
    })]);
    expect(state()).toMatchObject({ kind: "conflict", conflicts: [{ reason: "Abandoned operation has a later execution event." }] });
  });

  it.each([
    { name: "same issue", retained: { issueNumber: 1777, issueId: "I_1777", commentId: null },
      late: { issueNumber: 1777, issueId: "I_1777", commentId: null }, expected: "abandoned" },
    { name: "both null", retained: { issueNumber: null, issueId: null, commentId: null },
      late: { issueNumber: null, issueId: null, commentId: null }, expected: "abandoned" },
    { name: "different issue", retained: { issueNumber: 1777, issueId: "I_1777", commentId: null },
      late: { issueNumber: 1778, issueId: "I_1778", commentId: null }, expected: "conflict" },
    { name: "different issue ID", retained: { issueNumber: 1777, issueId: "I_1777", commentId: null },
      late: { issueNumber: 1777, issueId: "I_1778", commentId: null }, expected: "conflict" },
    { name: "late identity missing", retained: { issueNumber: 1777, issueId: "I_1777", commentId: null },
      late: { issueNumber: null, issueId: null, commentId: null }, expected: "conflict" },
    { name: "late identity newly populated", retained: { issueNumber: null, issueId: null, commentId: null },
      late: { issueNumber: 1777, issueId: "I_1777", commentId: null }, expected: "conflict" },
  ])("resolves late legacy evidence after a legacy-origin abandonment: $name", ({ retained, late, expected }) => {
    persist([
      { kind: "legacy_import", importedFrom: "original.jsonl:1", row: legacy({ result: retained }) },
      abandoned("legacy_unverified", retained),
      { kind: "legacy_import", importedFrom: "copy.jsonl:1", row: legacy({ result: late }) },
    ]);
    const resolved = state();
    expect(resolved.kind).toBe(expected);
    if (expected === "abandoned") expect(resolved).toMatchObject({ operation: { result: retained } });
    else expect(resolved).toMatchObject({ conflicts: [{ reason: "Abandoned operation has a later legacy execution row." }] });
  });

  it.each(ALLOWED.filter(({ kind }) => kind !== "legacy_unverified"))(
    "conflicts on matching late legacy evidence after a staged-origin $kind abandonment", ({ kind, rows, result }) => {
      const before = rows();
      persist([...before, abandoned(kind, { ...result, abandonment: { reason: REASON, operator: "operator",
        priorState: kind, priorEventRowNumber: before.length, at: NOW.toISOString() } }), legacy({ result })]);
      expect(state()).toMatchObject({ kind: "conflict", conflicts: [{ reason: "Abandoned operation has a later legacy execution row." }] });
    },
  );

  it.each([
    null, {}, { reason: "", operator: "operator" }, { reason: REASON, operator: "" },
    { reason: REASON, operator: "operator", priorState: "complete" },
    { reason: REASON, operator: "operator", priorState: { toString: null } },
  ])("refuses malformed abandonment metadata %j without throwing", (metadata) => {
    persist([event("create_unresolved"), abandoned("unresolved_unknown", { abandonment: metadata })]);
    expect(state()).toMatchObject({ kind: "malformed", problems: [{ reason: "Stored abandonment is malformed." }] });
  });

  it.each([
    { name: "self", priorEventRowNumber: 3 },
    { name: "future", priorEventRowNumber: 4 },
    { name: "missing", priorEventRowNumber: 999 },
    { name: "another staged fingerprint", prior: event("intent", { sourceFingerprint: "other" }) },
    { name: "another staged repository", prior: event("intent", { repository: "Other/repo" }) },
    { name: "another staged action", prior: event("intent", { action: "append_evidence" }) },
    { name: "another legacy fingerprint", prior: { kind: "legacy_import", row: legacy({ sourceFingerprint: "other" }) } },
    { name: "another legacy repository", prior: { kind: "legacy_import", row: legacy({ repository: "Other/repo" }) } },
    { name: "another legacy action", prior: { kind: "legacy_import", row: legacy({ actionTaken: "append_evidence" }) } },
  ])("rejects a persisted abandonment anchor to $name", ({ priorEventRowNumber = 1, prior = event("intent") }) => {
    persist([prior, event("create_unresolved"), abandoned("unresolved_unknown", {
      abandonment: { reason: REASON, operator: "operator", priorState: "unresolved_unknown",
        priorEventRowNumber, at: NOW.toISOString() },
    })]);
    expect(state()).toMatchObject({ kind: "malformed", problems: [{
      reason: "Stored abandonment priorEventRowNumber must refer to an earlier row of the same identity.",
      history: [{ rowNumber: 3 }],
    }] });
  });

  it("accepts an earlier same-identity anchor in persisted history with folded repository casing", () => {
    persist([event("intent", { repository: "OWNER/REPO" }), event("create_unresolved"), abandoned()]);
    expect(state().kind).toBe("abandoned");
  });

  it("accepts null abandonment metadata on a complete event", () => {
    persist([event("complete", { ...RESULT, abandonment: null })]);
    expect(state()).toMatchObject({ kind: "complete", operation: { result: RESULT } });
  });

  it("rejects abandonment metadata on a complete event", () => {
    persist([event("complete", { ...RESULT, abandonment: { reason: REASON, operator: "operator",
      priorState: "unresolved_unknown", priorEventRowNumber: 1, at: FIRST } })]);
    expect(state()).toMatchObject({ kind: "malformed", problems: [{
      reason: "Non-abandoned event carries abandonment metadata.",
    }] });
  });
});

describe("resolver status", () => {
  it("prints all unresolved kinds plus abandoned, conflict, malformed, and multiple actions oldest first", () => {
    const rows = ALLOWED.map(({ kind, rows }, index) => rows().map((row) => ({ ...row,
      sourceFingerprint: kind, appliedAt: `2026-09-${String(index + 2).padStart(2, "0")}T12:00:00.000Z` })));
    persist([
      event("create_unresolved", { sourceFingerprint: "abandoned", appliedAt: FIRST }),
      ...rows.reverse().flat(),
      abandoned("unresolved_unknown", { sourceFingerprint: "abandoned", appliedAt: FIRST,
        abandonment: { reason: REASON, operator: "operator", priorState: "unresolved_unknown", priorEventRowNumber: 1, at: FIRST } }),
      event("future_event", { sourceFingerprint: "malformed", appliedAt: "2026-09-08T12:00:00.000Z" }),
      event("intent", { sourceFingerprint: "conflict", appliedAt: "2026-09-09T12:00:00.000Z" }),
      event("intent", { sourceFingerprint: "conflict", appliedAt: "2026-09-10T12:00:00.000Z",
        payload: { issue: { title: "Changed", body: "Body" }, evidenceComment: null, closeIssue: null } }),
      legacy({ sourceFingerprint: "multiple_actions", actionTaken: null, intendedAction: null, appliedAt: "2026-09-11T12:00:00.000Z" }),
      legacy({ sourceFingerprint: "multiple_actions", appliedAt: "2026-09-11T12:00:00.000Z" }),
      legacy({ sourceFingerprint: "multiple_actions", actionTaken: "append_evidence", appliedAt: "2026-09-11T12:00:00.000Z" }),
      event("complete", { ...RESULT, sourceFingerprint: "completed" }),
      { mode: "dry-run", sourceFingerprint: "never_attempted" },
    ]);
    const before = readFileSync(journalPath);
    const result = cli(["status", `--repository=${REPOSITORY}`]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ repository: REPOSITORY, journalPath, journalTail: { present: false } });
    expect(report.operations).toEqual(report.summary.operations);
    expect(report.summary).toMatchObject({ operationsTotal: 13, unresolved: 3, unverified: 3, attention: 5,
      abandoned: 1, countsByState: { complete: 1, never_attempted: 0 }, oldestUnresolvedAgeDays: 13 });
    expect(report.operations.map((operation: { state: string }) => operation.state)).toEqual([
      "abandoned", ...ALLOWED.map(({ kind }) => kind), "malformed", "conflict", "multiple_actions", "multiple_actions", "multiple_actions",
    ]);
    expect(report.operations[0]).toEqual({ sourceFingerprint: "abandoned", action: "create_issue", state: "abandoned",
      issueNumber: null, issueId: null, commentId: null, firstAttemptAt: FIRST, lastEventAt: FIRST, ageDays: 14, lastError: REASON });
    expect(report.operations[7].lastError).toBe("Unknown execution event.");
    expect(report.operations[8]).toMatchObject({ lastError: "Conflicting populated issue payload.",
      firstAttemptAt: "2026-09-09T12:00:00.000Z", lastEventAt: "2026-09-10T12:00:00.000Z", ageDays: 6 });
    expect(readFileSync(journalPath)).toEqual(before);
    expect(existsSync(lockPath)).toBe(false);
    expect(fsyncSync).not.toHaveBeenCalled();
  });

  it("reports empty or unprovisioned journals without creating a claim or directory", () => {
    const result = cli(["status", `--repository=${REPOSITORY}`]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).operations).toEqual([]);
    expect(JSON.parse(result.stdout).summary).toMatchObject({ operationsTotal: 0, operations: [],
      ageEvidence: { withFirstAttempt: 0, withoutFirstAttempt: 0 } });
    expect(existsSync(dirname(journalPath))).toBe(false);
  });

  it("shows unknown timestamps, unattributable malformed bytes and an unterminated tail", () => {
    persist([legacy({ appliedAt: undefined }), { malformedJson: "{broken" }]);
    writeFileSync(journalPath, readFileSync(journalPath, "utf8") + '{"sourceFingerprint":"tail"');
    const result = cli(["status", `--repository=${REPOSITORY}`]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.journalTail).toEqual({ present: true });
    expect(report.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceFingerprint: null, state: "malformed", firstAttemptAt: null, lastEventAt: null, ageDays: null }),
      expect.objectContaining({ sourceFingerprint: "tail", state: "malformed", lastError: expect.stringContaining("Unterminated journal tail.") }),
    ]));
  });

  it("reads under a live claim and keeps repository casing in display but folds the journal path", () => {
    persist([event("create_unresolved", { error: "unknown response" }), event("intent", { repository: "Elsewhere/repo", sourceFingerprint: "elsewhere" })]);
    const claim = acquireExecutionClaim(journalPath, { mode: "execute" });
    try {
      const result = cli(["status", "--repository=OWNER/REPO"]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ repository: "OWNER/REPO", journalPath, operations: [{ lastError: "unknown response" }] });
      expect(JSON.parse(result.stdout).summary).toMatchObject({ operationsTotal: 1, unresolved: 1 });
    } finally { claim.release(); }
  });
});

describe("append emission selection", () => {
  const emissionA = "a".repeat(64);
  const emissionB = "b".repeat(64);
  const target = [`--repository=${REPOSITORY}`, `--source-fingerprint=${FINGERPRINT}`, "--action=append_evidence"];
  function rows() {
    const payload = { issue: null, evidenceComment: "Evidence", closeIssue: null };
    return [event("complete", { action: "append_evidence", payload, emissionContentSha256: emissionA, ...RESULT }),
      event("intent", { action: "append_evidence", payload, emissionContentSha256: emissionB })];
  }
  it("reads and abandons emission B only while retaining fingerprint-wide abandonment", () => {
    const before = rows();
    persist(before);
    const selected = cli(["status", ...target, `--emission-content-sha256=${emissionB}`]);
    expect(selected.code).toBe(0);
    expect(JSON.parse(selected.stdout).selection).toMatchObject({ kind: "intent_unknown",
      scope: { emissionContentSha256: emissionB }, operation: { event: { emissionContentSha256: emissionB } } });
    const result = cli(["abandon", ...target, `--emission-content-sha256=${emissionB}`,
      "--expected-state=intent_unknown", `--reason=${REASON}`, "--execute"]);
    expect(result.code).toBe(0);
    const journal = readJournal(journalPath);
    expect(journal.records.slice(0, before.length)).toEqual(before);
    expect(journal.records).toHaveLength(3);
    expect(journal.records.at(-1)).toMatchObject({ event: "abandoned", emissionContentSha256: emissionB,
      abandonment: { priorEventRowNumber: 2 } });
    const index = indexHistory(journal.records, journal.tail);
    expect([...index.staged.values()].find((operation) => operation.event.event !== "legacy_verified" && operation.event.emissionContentSha256 === emissionA)?.event.event).toBe("complete");
    expect(resolveDurableState(index, { ...IDENTITY, action: "append_evidence", emissionContentSha256: "c".repeat(64) }).kind).toBe("abandoned");
  });
  it.each(["status", "abandon"])("%s refuses ambiguous selection and names the emission selector", (command) => {
    persist(rows());
    const before = readFileSync(journalPath);
    const result = cli([command, ...target, ...(command === "abandon"
      ? ["--expected-state=intent_unknown", `--reason=${REASON}`, "--execute"] : [])]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("multiple_actions");
    expect(result.stderr).toContain("--emission-content-sha256");
    expect(readFileSync(journalPath)).toEqual(before);
  });
  it("keeps unambiguous status and abandonment working without an emission selector", () => {
    persist([rows()[1]]);
    const selected = cli(["status", ...target]);
    expect(selected.code).toBe(0);
    expect(JSON.parse(selected.stdout).selection.kind).toBe("intent_unknown");
    expect(cli(["abandon", ...target, "--expected-state=intent_unknown", `--reason=${REASON}`, "--execute"]).code).toBe(0);
  });
  it("refuses an unknown selector instead of abandoning a different unfinished emission", () => {
    persist(rows());
    const before = readFileSync(journalPath);
    const result = cli(["abandon", ...target, `--emission-content-sha256=${"c".repeat(64)}`,
      "--expected-state=intent_unknown", `--reason=${REASON}`, "--execute"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No append operation");
    expect(readFileSync(journalPath)).toEqual(before);
  });
  it.each([
    ["--action=create_issue", `--emission-content-sha256=${emissionB}`],
    ["--action=append_evidence", "--emission-content-sha256=invalid"],
    ["--action=append_evidence", `--emission-content-sha256=${emissionB.toUpperCase()}`],
    [`--emission-content-sha256=${emissionB}`],
  ])("rejects invalid status selectors %j before reading history", (...flags) => {
    const result = cli(["status", `--repository=${REPOSITORY}`, `--source-fingerprint=${FINGERPRINT}`, ...flags]);
    expect(result.code).toBe(2);
    expect(readFileSync).not.toHaveBeenCalled();
  });
  it.each(["legacy", "conflict", "unfinished"])("the selector retains the %s barrier", (barrier) => {
    const original = rows();
    persist(barrier === "legacy" ? [...original, legacy()]
      : barrier === "conflict" ? [...original, { ...original[0], payload: { issue: null, evidenceComment: "Conflicting evidence", closeIssue: null } }]
      : [{ ...original[0], event: "intent", issueNumber: null, issueId: null, commentId: null }, original[1]]);
    const before = readFileSync(journalPath);
    const result = cli(["abandon", ...target, `--emission-content-sha256=${emissionB}`,
      "--expected-state=intent_unknown", `--reason=${REASON}`, "--execute"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(barrier === "unfinished" ? "multiple_actions" : "conflict");
    expect(readFileSync(journalPath)).toEqual(before);
  });
});

describe("resolver abandon", () => {
  it.each(ALLOWED)("appends exactly one durable event after $kind, retaining all identities", ({ kind, rows, result }) => {
    persist(rows());
    const before = readFileSync(journalPath);
    const outcome = abandon(kind);
    expect(outcome).toMatchObject({ code: 0, stderr: "" });
    const journal = readJournal(journalPath);
    expect(journal.records).toHaveLength(rows().length + 1);
    expect(readFileSync(journalPath).subarray(0, before.length)).toEqual(before);
    expect(journal.records.at(-1)).toMatchObject({ ...IDENTITY, ...result,
      event: "abandoned", decisionContentSha256: "d".repeat(64),
      abandonment: { reason: REASON, operator: userInfo().username, priorState: kind,
        priorEventRowNumber: rows().length, at: NOW.toISOString() } });
    expect(state()).toMatchObject({ kind: "abandoned", operation: { result } });
    expect(JSON.parse(outcome.stdout).event).toEqual(journal.records.at(-1));
    expect(fsyncSync).toHaveBeenCalledTimes(2); // owner and journal, through the real fsync implementation
    expect(existsSync(lockPath)).toBe(false);
    const second = abandon(kind);
    expect(second).toEqual({ code: 1, stdout: "", stderr: "Abandon refused: current state abandoned (already abandoned)." });
    expect(readJournal(journalPath).records).toEqual(journal.records);
  });

  it("retains identities split across imported legacy rows and never invents missing bindings", () => {
    persist([
      { kind: "legacy_import", row: legacy({ decisionContentSha256: undefined, result: { issueNumber: 101, issueId: null, commentId: null } }) },
      { kind: "legacy_import", row: legacy({ decisionContentSha256: undefined, result: { issueNumber: null, issueId: "I_101", commentId: "IC_101" } }) },
    ]);
    expect(abandon("legacy_unverified").code).toBe(0);
    expect(readJournal(journalPath).records.at(-1)).toMatchObject({ ...RESULT, emissionContentSha256: null, decisionContentSha256: null });
    expect(state().kind).toBe("abandoned");
  });

  it.each([false, true].flatMap((imported) => [
    { imported, name: "absent", emissionContentSha256: undefined, decisionContentSha256: undefined },
    { imported, name: "null", emissionContentSha256: null, decisionContentSha256: null },
    { imported, name: "known decision", emissionContentSha256: null, decisionContentSha256: "d".repeat(64) },
    { imported, name: "known emission", emissionContentSha256: "e".repeat(64), decisionContentSha256: null },
  ]))("preserves $name legacy bindings (imported=$imported) through abandonment and status", ({ imported, emissionContentSha256, decisionContentSha256 }) => {
    const row = legacy({ emissionContentSha256, decisionContentSha256 });
    persist([imported ? { kind: "legacy_import", row } : row]);
    const before = readFileSync(journalPath);
    const preview = abandon("legacy_unverified", []);
    expect(preview.code).toBe(0);
    expect(readFileSync(journalPath)).toEqual(before);
    expect(existsSync(lockPath)).toBe(false);
    expect(abandon("legacy_unverified").code).toBe(0);
    const journal = readJournal(journalPath);
    expect(journal.records).toHaveLength(2);
    expect(journal.records.at(-1)).toEqual(JSON.parse(preview.stdout).event);
    expect(journal.records.at(-1)).toMatchObject({
      emissionContentSha256: emissionContentSha256 ?? null,
      decisionContentSha256: decisionContentSha256 ?? null,
      ...RESULT,
    });
    expect(readFileSync(journalPath).subarray(0, before.length)).toEqual(before);
    expect(state().kind).toBe("abandoned");
    const status = cli(["status", `--repository=${REPOSITORY}`]);
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout).operations).toEqual([
      { sourceFingerprint: FINGERPRINT, action: "create_issue", state: "abandoned", ...RESULT,
        firstAttemptAt: FIRST, lastEventAt: NOW.toISOString(), ageDays: 14, lastError: REASON },
    ]);
  });

  it("abandons an evidence append independently of a completed create for the same fingerprint", () => {
    const result = { issueNumber: 202, issueId: 1202, commentId: 2202 };
    const payload = { issue: null, evidenceComment: "Evidence", closeIssue: {
      targetIssueNumber: 202, before: "OPEN", after: "CLOSED", evidenceIds: ["evidence"],
    } };
    persist([event("complete", RESULT), event("classification_failed", { action: "append_evidence", payload, ...result })]);
    const before = readFileSync(journalPath);
    const outcome = cli(["abandon", `--repository=${REPOSITORY}`, `--source-fingerprint=${FINGERPRINT}`,
      "--action=append_evidence", "--expected-state=classification_failed", `--reason=${REASON}`, "--execute"]);
    expect(outcome).toMatchObject({ code: 0, stderr: "" });
    const journal = readJournal(journalPath);
    expect(journal.records).toHaveLength(3);
    expect(journal.records.at(-1)).toMatchObject({ ...IDENTITY, action: "append_evidence", event: "abandoned", payload, ...result,
      abandonment: { priorState: "classification_failed", priorEventRowNumber: 2, reason: REASON } });
    expect(readFileSync(journalPath).subarray(0, before.length)).toEqual(before);
    const index = indexHistory(journal.records);
    expect(resolveDurableState(index, IDENTITY).kind).toBe("complete");
    expect(resolveDurableState(index, { ...IDENTITY, action: "append_evidence" })).toMatchObject({ kind: "abandoned", operation: { result } });
    const status = cli(["status", `--repository=${REPOSITORY}`]);
    expect(JSON.parse(status.stdout).operations).toEqual([
      { sourceFingerprint: FINGERPRINT, action: "append_evidence", state: "abandoned", ...result,
        firstAttemptAt: FIRST, lastEventAt: NOW.toISOString(), ageDays: 14, lastError: REASON },
    ]);
    expect(existsSync(lockPath)).toBe(false);
  });

  it.each([
    { kind: "never_attempted", rows: () => [], refusal: "Abandon refused: current state never_attempted." },
    { kind: "complete", rows: () => [event("complete", RESULT)], refusal: "Abandon refused: current state complete." },
    { kind: "abandoned", rows: () => [event("create_unresolved"), abandoned()],
      refusal: "Abandon refused: current state abandoned (already abandoned)." },
    { kind: "malformed", rows: () => [event("future_event")],
      refusal: "Abandon refused: current state malformed. Inspect `status` output for this fingerprint and repair the journal by hand after confirming no intake run is live." },
    { kind: "conflict", rows: () => [event("intent"), event("intent", { payload: { issue: { title: "Other", body: "Body" }, evidenceComment: null, closeIssue: null } })],
      refusal: "Abandon refused: current state conflict. Inspect `status` output for this fingerprint and repair the journal by hand after confirming no intake run is live." },
    { kind: "multiple_actions", rows: () => [legacy(), legacy({ actionTaken: "append_evidence" })],
      refusal: "Abandon refused: current state multiple_actions. Pass `--action` to select one of: append_evidence, create_issue." },
  ])("refuses $kind without appending", ({ rows, refusal }) => {
    persist(rows());
    const before = readFileSync(journalPath);
    expect(abandon()).toEqual({ code: 1, stdout: "", stderr: refusal });
    expect(readFileSync(journalPath)).toEqual(before);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("refuses a stale expected state after reading the authoritative journal", () => {
    persist([event("created", RESULT)]);
    const before = readFileSync(journalPath);
    expect(abandon()).toEqual({ code: 1, stdout: "", stderr: "Abandon refused: current state primary_unverified; expected state unresolved_unknown." });
    expect(readFileSync(journalPath)).toEqual(before);
  });

  it.each([
    { kind: "unresolved_unknown", row: () => event("create_unresolved") },
    { kind: "legacy_unverified", row: () => ({ kind: "legacy_import", row: legacy() }) },
  ])("anchors $kind to its latest event under the claim, excluding unrelated later rows", ({ kind, row }) => {
    persist([row(), row(), event("intent", { sourceFingerprint: "other" })]);
    expect(abandon(kind).code).toBe(0);
    expect(readJournal(journalPath).records.at(-1)).toMatchObject({
      event: "abandoned", abandonment: { priorEventRowNumber: 2 },
    });
    expect(state().kind).toBe("abandoned");
  });

  it.each([
    { kind: "unresolved_unknown", row: () => event("create_unresolved") },
    { kind: "legacy_unverified", row: () => ({ kind: "legacy_import", row: legacy() }) },
  ])("refuses a stale $kind row anchor when re-resolved under the claim", async ({ kind, row }) => {
    persist([row()]);
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    let changed = false;
    vi.mocked(readFileSync).mockImplementation(((path: Parameters<typeof readFileSync>[0], options: never) => {
      const bytes = fs.readFileSync(path, options);
      if (path === journalPath && !changed) {
        changed = true;
        expect(JSON.parse(fs.readFileSync(join(lockPath, "owner.json"), "utf8")).mode).toBe("resolve");
        fs.appendFileSync(journalPath, JSON.stringify(row()) + "\n");
      }
      return bytes;
    }) as typeof readFileSync);
    expect(abandon(kind)).toEqual({ code: 1, stdout: "",
      stderr: "Abandon refused: priorEventRowNumber 1; latest event row 2." });
    expect(changed).toBe(true);
    expect(readJournal(journalPath).records).toEqual([row(), row()]);
    expect(existsSync(lockPath)).toBe(false);
    expect(fsyncSync).toHaveBeenCalledTimes(1);
  });

  it("previews under a live execute claim without fsync, writing, or changing ownership", () => {
    persist([event("create_unresolved")]);
    const before = readFileSync(journalPath);
    const claim = acquireExecutionClaim(journalPath, { mode: "execute" });
    const owner = readFileSync(join(lockPath, "owner.json"));
    vi.mocked(fsyncSync).mockClear();
    try {
      const result = abandon("unresolved_unknown", []);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ execute: false, event: { event: "abandoned", abandonment: { reason: REASON } } });
      expect(readFileSync(journalPath)).toEqual(before);
      expect(readFileSync(join(lockPath, "owner.json"))).toEqual(owner);
      expect(fsyncSync).not.toHaveBeenCalled();
    } finally { claim.release(); }
  });

  it.each(["execute", "import", "resolve"] as const)("refuses a live %s claim before reading the journal", (mode) => {
    persist([event("create_unresolved")]);
    const before = readFileSync(journalPath);
    const claim = acquireExecutionClaim(journalPath, { mode });
    const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
    vi.mocked(readFileSync).mockClear();
    try {
      const result = abandon();
      expect(result).toEqual({ code: 1, stdout: "", stderr: `Execution journal claim refused: ${lockPath} is held by pid ${owner.pid} on ${owner.hostname}, acquiredAt ${owner.acquiredAt}, mode ${mode}. The run must be stopped (or the host restarted) before the claim can be cleared; if pid ${owner.pid} is not an intake run, stop it or reboot.` });
      expect(vi.mocked(readFileSync).mock.calls.some(([path]) => path === journalPath)).toBe(false);
      expect(readFileSync(journalPath)).toEqual(before);
    } finally { claim.release(); }
  });

  it.each([1, 2])("revalidates the token after journal read %s and before append, preserving the replacement claim", async (replaceOnRead) => {
    persist([event("create_unresolved")]);
    const before = readFileSync(journalPath);
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const ownerPath = join(lockPath, "owner.json");
    let replaced = false;
    let journalReads = 0;
    vi.mocked(readFileSync).mockImplementation(((path: Parameters<typeof readFileSync>[0], options: never) => {
      const bytes = fs.readFileSync(path, options);
      if (path === journalPath && ++journalReads === replaceOnRead) {
        replaced = true;
        const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
        expect(owner.mode).toBe("resolve");
        fs.writeFileSync(ownerPath, JSON.stringify({ ...owner, token: "b".repeat(32) }));
      }
      return bytes;
    }) as typeof readFileSync);
    expect(abandon()).toEqual({ code: 1, stdout: "", stderr: `Execution journal ownership lost: ${lockPath}; owner metadata is missing, unreadable, or belongs to someone else. No write or release is permitted.` });
    expect(replaced).toBe(true);
    expect(readFileSync(journalPath)).toEqual(before);
    expect(JSON.parse(readFileSync(ownerPath, "utf8")).token).toBe("b".repeat(32));
    expect(fsyncSync).toHaveBeenCalledTimes(1);
  });

  it("refuses a torn tail without repairing bytes and releases the claim", () => {
    persist([event("create_unresolved")]);
    writeFileSync(journalPath, readFileSync(journalPath, "utf8") + '{"other":');
    const before = readFileSync(journalPath);
    expect(abandon()).toMatchObject({ code: 1, stderr: `Execution journal write failed: ${journalPath}` });
    expect(readFileSync(journalPath)).toEqual(before);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("resolver CLI contract", () => {
  it.each(["conflict", "complete", "unresovled_unknown"])("rejects --expected-state=%s before any claim or journal read", (expected) => {
    expect(abandon(expected)).toMatchObject({ code: 2, stdout: "", stderr: expect.stringMatching(/^Usage:/) });
    expect(existsSync(dirname(journalPath))).toBe(false);
    expect(readFileSync).not.toHaveBeenCalled();
    expect(fsyncSync).not.toHaveBeenCalled();
  });

  it.each(["", " \t ", "a".repeat(501), "first\nsecond", "first\rsecond", "first\r\nsecond"])("rejects an invalid reason %j before any claim or journal read", (reason) => {
    expect(cli(["abandon", `--repository=${REPOSITORY}`, `--source-fingerprint=${FINGERPRINT}`,
      "--action=create_issue", "--expected-state=unresolved_unknown", `--reason=${reason}`, "--execute"]))
      .toMatchObject({ code: 2, stdout: "", stderr: expect.stringMatching(/^Usage:/) });
    expect(existsSync(dirname(journalPath))).toBe(false);
    expect(readFileSync).not.toHaveBeenCalled();
    expect(fsyncSync).not.toHaveBeenCalled();
  });

  it("accepts a 500-character reason unchanged", () => {
    persist([event("create_unresolved")]);
    const reason = "a".repeat(500);
    expect(cli(["abandon", `--repository=${REPOSITORY}`, `--source-fingerprint=${FINGERPRINT}`,
      "--action=create_issue", "--expected-state=unresolved_unknown", `--reason=${reason}`, "--execute"]).code).toBe(0);
    expect(readJournal(journalPath).records.at(-1)).toMatchObject({ event: "abandoned", abandonment: { reason } });
  });

  it.each([{ flags: [] }, { flags: ["--execute"] }])("rejects the removed issue-number hint with flags $flags", ({ flags }) => {
    const result = cli(["reconcile", `--repository=${REPOSITORY}`, `--source-fingerprint=${FINGERPRINT}`,
      "--action=create_issue", "--issue-number=101", ...flags]);
    expect(result).toMatchObject({ code: 2, stdout: "", stderr: expect.stringMatching(/^Usage:/) });
    expect(existsSync(dirname(journalPath))).toBe(false);
    expect(fsyncSync).not.toHaveBeenCalled();
  });

  it.each([
    [], ["unknown"], ["status"], ["status", "--repository=invalid"], ["status", `--repository=${REPOSITORY}`, "--execute"],
    ["abandon", `--repository=${REPOSITORY}`], ["reconcile", `--repository=${REPOSITORY}`],
    ["reconcile", `--repository=${REPOSITORY}`, `--source-fingerprint=${FINGERPRINT}`, "--action=create_issue", "--issue-number=0"],
  ].map((args) => ({ args })))("prints usage and exits 2 for $args", ({ args }) => {
    expect(cli(args)).toMatchObject({ code: 2, stdout: "", stderr: expect.stringMatching(/^Usage:/) });
    expect(existsSync(dirname(journalPath))).toBe(false);
  });

  it.each(["reason", "action", "expected-state", "source-fingerprint"])("requires non-empty --%s", (flag) => {
    const args = ["abandon", `--repository=${REPOSITORY}`, `--source-fingerprint=${FINGERPRINT}`, "--action=create_issue",
      "--expected-state=unresolved_unknown", "--reason=reason", "--execute"];
    expect(cli(args.filter((arg) => !arg.startsWith(`--${flag}=`))).code).toBe(2);
    expect(cli(args.map((arg) => arg.startsWith(`--${flag}=`) ? `--${flag}= ` : arg)).code).toBe(2);
  });
});

type Mutable<T> = T extends string | number | boolean | null ? T : { -readonly [K in keyof T]: Mutable<T[K]> };
const OWNER_FINGERPRINT = "839b48ef00d8eb619dd2bb0d20896c29c6d6187b11f758994356605453c634e4";
const OWNER_EMISSION = "27a9b075b531e5ccdf921c88e95af69b16eb05ace05dac77d4ca6bbc7bfa76b5";
const CENSUS_REPOSITORY = "example-org/example-repo";
const CREATE_IDENTITY = { repository: CENSUS_REPOSITORY, sourceFingerprint: OWNER_FINGERPRINT, action: "create_issue" as const };
// Private captured-fixture replay is excluded from this public source copy.

// Private captured-fixture replay is excluded from this public source copy.

