import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FILE_FINDING_ROOT, checkCensusJournal, censusNeedsRefreshBeforeApply, fileFindingExitCode, fileFindingFixingCommand, runFileFindingCli, runFileFindingCommand, type FileFindingResult } from "../github-issue-roadmap-file-finding";
import { executionEvent, type OperatorIntakeApprovalTransport } from "../github-issue-roadmap-intake-apply";
import * as intakeApply from "../github-issue-roadmap-intake-apply";
import * as intakeApprove from "../github-issue-roadmap-intake-approve";
import type { runIntakePreflightCli as intakePreflight } from "../github-issue-roadmap-intake-preflight";
import type { runPreflightCli as canonicalPreflight } from "../github-issue-roadmap-preflight";
import * as preflight from "../github-issue-roadmap-preflight";
import * as existenceProbe from "../github-issue-roadmap-existence-probe";
import * as sharedCensusStore from "../lib/github-issue-roadmap/shared-census-store";
import { assertSharedCensusPath, publishSharedCensus, type SharedCensusBundle } from "../lib/github-issue-roadmap/shared-census-store";
import { type CanonicalSnapshotV2 } from "../lib/github-issue-roadmap/snapshot-v2";
import { AssessmentEvidenceViewCapError } from "../lib/github-issue-roadmap/assessment-evidence-view";
import capabilities from "../github-issue-roadmap-capabilities.json";
import * as qualification from "../lib/github-issue-roadmap/action-qualification";
import { parseDispatcherCapabilityManifest } from "../lib/github-issue-roadmap/capability-manifest";
import { createGitHubIntakeApprovalTransport } from "../lib/github-issue-roadmap/github-intake-approval-transport";
import { canonicalJsonSha256, prettyCanonicalJson } from "../lib/github-issue-roadmap/canonical-json";
import { runCredentialCleanGit } from "../lib/github-issue-roadmap/credential-clean-git";
import { dispositionHistory } from "../lib/github-issue-roadmap/disposition-history";
import * as dispositionSelection from "../lib/github-issue-roadmap/disposition-selection";
import * as findingDelivery from "../lib/github-issue-roadmap/finding-delivery";
import * as intakeAssessment from "../lib/github-issue-roadmap/intake-assessment";
import type { CriteriaAuthorshipLookup } from "../lib/github-issue-roadmap/disposition-selection";
import { runJudgeCli, resolveActionJudgementRoot } from "../github-issue-roadmap-judge";
import * as judgeCli from "../github-issue-roadmap-judge";
import { compileIntakeDecision, deriveIntakeObservationOperands, INTAKE_CALIBRATION_SCORING_VERSION } from "../lib/github-issue-roadmap/intake-decision";
import { bankIntakeObservation } from "../lib/github-issue-roadmap/intake-observation";
import { actionMaterialRoot, buildJudgementRecord, readJudgementRecordRevisions } from "../lib/github-issue-roadmap/judgement-record";
import { parseAssessmentStackDescriptor, parseIntakeAssessment, type AssessmentStackIdentity } from "../lib/github-issue-roadmap/intake-assessment";
import { REPO_ASSESSMENT_PROMPT, REPO_STACK_DESCRIPTOR, type IntakeAssessmentModelCaller } from "../lib/github-issue-roadmap/intake-assessment-evaluator";
import * as assessmentEvaluator from "../lib/github-issue-roadmap/intake-assessment-evaluator";
import * as executionJournal from "../lib/github-issue-roadmap/intake-execution-journal";
import { acquireExecutionClaim, appendJournal, readJournal, resolveJournalPath } from "../lib/github-issue-roadmap/intake-execution-journal";
import { verifyRunEvidence } from "../lib/github-issue-roadmap/intake-run-evidence";
import * as intakeShadow from "../lib/github-issue-roadmap/intake-shadow";
import { buildIntakeSnapshot, parseIntakeSnapshotV1, type IntakeSnapshotV1, type IntakeIssueInput } from "../lib/github-issue-roadmap/intake-snapshot";
import { createOutcomeEnvelope, outcomeSourceContentSha256, OUTCOME_ENVELOPE_SCHEMA_VERSION_V2, type OutcomeEnvelope } from "../lib/github-issue-roadmap/outcome-candidate";
import * as readOnlyReader from "../lib/github-issue-roadmap/read-only-github-reader";
import { boardCheckResponse, buildIntakeStack, canonicalFixture, censusBundle, censusIssue, censusPass, markerBlock, stackEnvelope, stackSnapshot } from "./__helpers__/roadmap-intake-stack";
import { evidenceAssessment } from "./__helpers__/roadmap-run-evidence";
import { validCanonicalSnapshotV2 } from "./__helpers__/canonical-snapshot-v2";

const NOW = new Date("2026-08-20T12:00:03.000Z");
const MAIN = "e".repeat(40);
const HEAD = "f".repeat(40);
const SOURCE = "# Committed finding\n";
const roots: string[] = [];
let exitCode: typeof process.exitCode;

it("routes coded cap failures to advice naming the cap and its value, and plain assessor failures to seat advice", () => {
  const args = { candidate: "finding.json", repository: "example-org/example-repo" } as Parameters<typeof fileFindingFixingCommand>[1];
  const viewCap = new AssessmentEvidenceViewCapError(900_001, 900_000);
  expect(fileFindingFixingCommand(`assessor_unavailable: ${viewCap.message}`, args, "run"))
    .toBe("The assessment evidence view is over its 900000-character view cap even after trimming optional bodies and excerpting long mandatory bodies; this is not a Codex seat failure. Do not retry unchanged: raise ASSESSMENT_EVIDENCE_VIEW_CHARACTER_CAP in scripts/lib/github-issue-roadmap/assessment-evidence-view.ts within the 1048576-character seat input cap, or reduce the fixed per-issue payload.");
  expect(fileFindingFixingCommand("assessor_unavailable: view_cap_exceeded: Evidence exceeds its budget.", args, "run"))
    .toContain("over its view cap even after");
  expect(fileFindingFixingCommand("assessor_unavailable: seat_input_cap_exceeded: Assessment input is 1048577 characters; the seat input cap is 1048576.", args, "run"))
    .toBe("The assessment input is over the 1048576-character seat input cap; this is not a Codex seat failure. Do not retry unchanged: lower ASSESSMENT_EVIDENCE_VIEW_CHARACTER_CAP in scripts/lib/github-issue-roadmap/assessment-evidence-view.ts or shrink the candidate envelope so the input fits.");
  const seatAdvice = "Get-Command codex.cmd; codex login status; restore the requested Codex seat and rerun filing.";
  expect(fileFindingFixingCommand("assessor_unavailable: Codex seat unavailable.", args, "run")).toBe(seatAdvice);
  expect(fileFindingFixingCommand("assessor_unavailable: the view cap is mentioned in seat output.", args, "run")).toBe(seatAdvice);
});

beforeEach(() => { exitCode = process.exitCode; });
afterEach(() => {
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function files(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else result[relative(root, path)] = readFileSync(path).toString("base64");
    }
  };
  visit(root);
  return result;
}

function fixture(count = 1, completionRule?: string, dispositionedCount = 0) {
  const root = mkdtempSync(join(tmpdir(), "roadmap-file-finding-"));
  roots.push(root);
  vi.stubEnv("ROADMAP_INTAKE_JOURNAL_ROOT", join(root, "journal"));
  const base = stackEnvelope(count);
  const hash = outcomeSourceContentSha256(Buffer.from(SOURCE));
  const envelope = createOutcomeEnvelope({ ...base,
    ...(dispositionedCount > 0 ? { schemaVersion: OUTCOME_ENVELOPE_SCHEMA_VERSION_V2 } : {}),
    artifact: { ...base.artifact, revisionSha256: hash },
    candidates: base.candidates.map(({ sourceFingerprint: _fingerprint, emissionContentSha256: _emission, ...candidate }, index) => ({
      ...candidate,
      ...(index >= count - dispositionedCount ? { disposition: { kind: "achieved" as const, commits: [{ sha: MAIN }], note: "Done." } } : {}),
      outcome: { ...candidate.outcome, completionRule: completionRule ?? candidate.outcome.completionRule },
      evidence: candidate.evidence.map((citation) => ({ ...citation, contentSha256: hash })),
      provenance: candidate.provenance.map((citation) => ({ ...citation, contentSha256: hash })),
    })),
  });
  const write = (locator: string, value: string) => {
    const path = join(root, locator);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
    return path;
  };
  for (const locator of [envelope.artifact.sourceLocator,
    ...envelope.candidates[0].evidence.map((citation) => citation.sourceLocator)]) write(locator, SOURCE);
  for (const locator of [REPO_ASSESSMENT_PROMPT, REPO_STACK_DESCRIPTOR, "scripts/github-issue-roadmap-assessment-schema.json"]) {
    write(locator, readFileSync(join(process.cwd(), locator), "utf8"));
  }
  const candidatePath = write("finding.roadmap-outcomes.json", JSON.stringify(envelope));
  const canonicalSnapshot = canonicalFixture(envelope.repository, NOW);
  const census = censusBundle(stackSnapshot(envelope, censusPass()), NOW, canonicalSnapshot).intakeSnapshot;
  let liveIssues = census.issues;
  const publishCensus = (snapshot: IntakeSnapshotV1) => {
    liveIssues = snapshot.issues;
    const claim = acquireExecutionClaim(resolveJournalPath("example-org/example-repo"), { mode: "preflight" });
    try {
      publishSharedCensus("example-org/example-repo", claim, censusBundle(snapshot, NOW, undefined, readJournal(resolveJournalPath("example-org/example-repo")).records));
      return assertSharedCensusPath("example-org/example-repo", claim);
    } finally { claim.release(); }
  };
  const censusPath = publishCensus(census);
  const blob = (bytes: string) => createHash("sha1").update(bytes).digest("hex");
  const runGit = vi.fn((_cwd: string, args: readonly string[]) => {
    if (args[0] === "rev-parse") {
      if (args.includes("--is-shallow-repository")) return "false";
      if (args[2] === "HEAD^{commit}") return HEAD;
      if (args[2].startsWith(`${HEAD}:`)) return blob(SOURCE);
      if (args[2] === "origin/main^{commit}" || args[2] === `${MAIN}^{commit}`) return MAIN;
    }
    if (args[0] === "cat-file" && args[1] === "blob" && args[2] === blob(SOURCE)) return Buffer.from(SOURCE).toString("base64");
    if (args[0] === "ls-tree" || args[0] === "log") return "";
    throw new Error(`Unexpected git command ${args.join(" ")}`);
  });
  const caller = vi.fn<IntakeAssessmentModelCaller>(async (call) => {
    const candidate = call.evidence.candidateEnvelope as OutcomeEnvelope;
    const snapshot = call.evidence.intakeSnapshot as IntakeSnapshotV1;
    const request = call.evidence.assessmentRequest as { assessmentStack: AssessmentStackIdentity };
    return { provider: call.provider, model: call.model,
      output: { ...evidenceAssessment(candidate, snapshot), stack: request.assessmentStack } };
  });
  let nextIssueNumber = 1901;
  const transport = {
    preflightClassifications: vi.fn(async () => {}),
    createIssue: vi.fn(async () => { const issueNumber = nextIssueNumber++; return { issueNumber, issueId: `I_${issueNumber}` }; }),
    appendEvidenceComment: vi.fn(async () => ({ commentId: "C_1901" })),
    closeIssue: vi.fn(async () => {}),
    applyClassification: vi.fn(async () => ({})),
    verifyClassifications: vi.fn(async () => true),
    fetchIssue: vi.fn<NonNullable<OperatorIntakeApprovalTransport["fetchIssue"]>>(async () => { throw new Error("No ownership GET expected."); }),
  } satisfies OperatorIntakeApprovalTransport;
  const openTransport = vi.fn(() => transport);
  const log = vi.fn();
  const argv = [`--candidate=${candidatePath}`, "--repository=example-org/example-repo"];
  const runPreflightCli = vi.fn<typeof canonicalPreflight>(() => { throw new Error("Unexpected census capture"); });
  const runIntakePreflightCli = vi.fn<typeof intakePreflight>(() => { throw new Error("Unexpected intake capture"); });
  const runBoardCheckGh = vi.fn<readOnlyReader.GhRunner>(args => {
    const body = args.includes("graphql") ? { data: { repository: { nameWithOwner: "example-org/example-repo",
      issues: { totalCount: liveIssues.filter(issue => issue.state === "OPEN").length,
        pageInfo: { hasNextPage: false, endCursor: null }, nodes: liveIssues.filter(issue => issue.state === "OPEN").map(issue => ({
          number: issue.number, databaseId: issue.identity.databaseId, id: issue.identity.nodeId, state: issue.state, updatedAt: issue.updatedAt,
          issueFieldValues: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } },
        })) } } } } : liveIssues.map(issue => ({ number: issue.number, updated_at: issue.updatedAt }));
    return `HTTP/2.0 200 OK\r\nx-github-request-id: fixture\r\nx-github-api-version-selected: 2026-03-10\r\n\r\n${JSON.stringify(body)}`;
  });
  const input = { argv, repoRoot: root, runGit, caller, openTransport, runPreflightCli, runIntakePreflightCli, now: () => NOW, log,
    runBoardCheckGh,
    dispositionHistory: (() => new Map()) as typeof dispositionHistory,
    criteriaAuthorship: (() => "unknown") as CriteriaAuthorshipLookup };
  const execute = () => runFileFindingCli({ ...input, argv: [...argv, "--execute"], operatorToken: "fixture-token" });
  const untouchedTransport = () => {
    expect(openTransport).not.toHaveBeenCalled();
    for (const method of Object.values(transport)) expect(method).not.toHaveBeenCalled();
  };
  return { root, envelope, census, canonicalSnapshot, censusPath, publishCensus, candidatePath, write, input, execute, caller, transport, openTransport, log, untouchedTransport };
}

function captureRunners(value: ReturnType<typeof fixture>, now = () => NOW, census = value.census) {
  const callerCwd = process.cwd();
  let cwd = callerCwd;
  vi.spyOn(process, "cwd").mockImplementation(() => cwd);
  const chdir = vi.spyOn(process, "chdir").mockImplementation(path => { cwd = String(path); });
  const outputPath = (argv: readonly string[], name = "out") => argv.find(arg => arg.startsWith(`--${name}=`))!.slice(name.length + 3);
  const runPreflightCli = vi.fn<typeof canonicalPreflight>(argv => {
    expect(process.cwd()).toBe(value.root);
    expect(argv).toContain("--snapshot-version=v2");
    expect(() => acquireExecutionClaim(resolveJournalPath("example-org/example-repo"), { mode: "execute" })).toThrow();
    writeFileSync(outputPath(argv), JSON.stringify(value.canonicalSnapshot), { flag: "wx" });
    writeFileSync(outputPath(argv, "fingerprint-out"), JSON.stringify(censusBundle(census, NOW).boardFingerprint), { flag: "wx" });
  });
  const runIntakePreflightCli = vi.fn<typeof intakePreflight>((argv, repoRoot, _readGh, claim) => {
    expect(process.cwd()).toBe(value.root);
    expect(repoRoot).toBe(value.root);
    expect(claim).toBeDefined();
    expect(JSON.parse(readFileSync(outputPath(argv, "fingerprint"), "utf8"))).toEqual(censusBundle(census, NOW).boardFingerprint);
    const envelope = JSON.parse(readFileSync(outputPath(argv, "candidate"), "utf8"));
    const pass = censusPass(census.issues.map(issue => censusIssue({ ...issue.identity, body: issue.body,
      title: issue.title, state: issue.state, updatedAt: issue.updatedAt, fieldValues: issue.fieldValues })));
    const capturedAt = now().toISOString();
    const capturedPass = { ...pass, completedAt: capturedAt,
      receipts: pass.receipts.map(receipt => ({ ...receipt, fetchedAt: capturedAt })) };
    const bookend = { completedAt: capturedAt, excludedPullRequestCount: pass.excludedPullRequestCount,
      updatedAt: Object.fromEntries(pass.issues.map(issue => [issue.number, issue.updatedAt])), receipts: [] };
    const snapshot = buildIntakeSnapshot({
      candidateSha256: canonicalJsonSha256(envelope), canonicalSnapshotV2Sha256: value.census.canonicalSnapshotV2Sha256,
      generatedAt: capturedAt, pass: capturedPass, bookend,
      projectObservation: value.census.projectObservation,
    });
    claim!.withOwnership(() => writeFileSync(outputPath(argv), JSON.stringify(snapshot), { flag: "wx" }));
    writeFileSync(outputPath(argv, "census-pass-out"), JSON.stringify({ pass: capturedPass, bookend }), { flag: "wx" });
    return outputPath(argv);
  });
  return { runPreflightCli, runIntakePreflightCli, chdir, callerCwd, outputPath };
}

function allowCapture(value: ReturnType<typeof fixture>) {
  const snapshot = (JSON.parse(readFileSync(value.censusPath, "utf8")) as SharedCensusBundle).intakeSnapshot;
  Object.assign(value.input, captureRunners(value, () => NOW, snapshot));
}

function installRefreshBundle(value: ReturnType<typeof fixture>, pass = censusPass()) {
  const old = JSON.parse(readFileSync(value.censusPath, "utf8"));
  const intakeBookend = { completedAt: NOW.toISOString(), excludedPullRequestCount: pass.excludedPullRequestCount,
    updatedAt: Object.fromEntries(pass.issues.map(issue => [issue.number, issue.updatedAt])), receipts: [] };
  const intakeSnapshot = buildIntakeSnapshot({ candidateSha256: old.intakeSnapshot.candidateSha256,
    canonicalSnapshotV2Sha256: canonicalJsonSha256(old.canonicalSnapshot), generatedAt: NOW.toISOString(),
    pass, bookend: intakeBookend, projectObservation: old.intakeSnapshot.projectObservation });
  writeFileSync(value.censusPath, JSON.stringify({ ...old, schemaVersion: "github-issue-roadmap-shared-census/v3",
    intakePass: pass, intakeBookend, intakeSnapshot, boardFingerprint: censusBundle(intakeSnapshot, NOW).boardFingerprint }));
  return pass;
}

function refreshReader(value: ReturnType<typeof fixture>, issues: readonly IntakeIssueInput[],
  mutate?: (body: unknown, endpoint: string, read: number) => unknown) {
  let reads = 0;
  value.input.runBoardCheckGh.mockImplementation(args => {
    expect(() => acquireExecutionClaim(resolveJournalPath("example-org/example-repo"), { mode: "execute" })).toThrow();
    const endpoint = args.includes("graphql") ? "graphql" : args.at(-1)!;
    const row = (issue: IntakeIssueInput) => ({ number: issue.number, id: issue.databaseId, node_id: issue.nodeId,
      repository_url: `https://api.github.com/repos/${issue.repositoryFullName}`, title: issue.title, state: issue.state.toLowerCase(),
      state_reason: issue.stateReason, body: issue.body, updated_at: issue.updatedAt, type: issue.nativeType });
    let body: unknown;
    if (endpoint === "graphql") body = { data: { repository: { nameWithOwner: "example-org/example-repo", issues: {
      totalCount: issues.filter(issue => issue.state === "OPEN").length, pageInfo: { hasNextPage: false, endCursor: null },
      nodes: issues.filter(issue => issue.state === "OPEN").map(issue => ({ number: issue.number, databaseId: issue.databaseId,
        id: issue.nodeId, state: issue.state, updatedAt: issue.updatedAt, issueFieldValues: {
          totalCount: issue.fieldValues.length, pageInfo: { hasNextPage: false }, nodes: issue.fieldValues.map(raw => {
            const field = raw as { issue_field_name: string; single_select_option: { name: string } };
            return { __typename: "IssueFieldSingleSelectValue", field: { name: field.issue_field_name }, name: field.single_select_option.name };
          }),
        } })),
    } } } };
    else if (endpoint.includes("issues?state=all")) body = issues.map(row);
    else {
      const issue = issues.find(issue => endpoint.includes(`/issues/${issue.number}`));
      if (!issue) throw new Error(`Unexpected targeted read: ${endpoint}`);
      body = endpoint.includes("/comments?") ? issue.comments.map(comment => ({ id: comment.databaseId, node_id: comment.nodeId,
        body: comment.body, user: { login: comment.author }, created_at: comment.createdAt, updated_at: comment.updatedAt }))
        : endpoint.includes("/issue-field-values?") ? issue.fieldValues : row(issue);
    }
    body = mutate?.(body, endpoint, ++reads) ?? body;
    return `HTTP/2.0 200 OK\r\nx-github-request-id: refresh-${reads}\r\nx-github-api-version-selected: 2026-03-10\r\n\r\n${JSON.stringify(body)}`;
  });
}

describe("U4b targeted refresh", () => {
  it.each([false, true])("picks up an appended marker comment without a full capture (closed=%s)", async closed => {
    const value = fixture(2);
    const original = censusIssue({ number: 1901, databaseId: 1901, nodeId: "I_1901" });
    installRefreshBundle(value, censusPass([original]));
    seedComplete({ ...value.envelope, candidates: [value.envelope.candidates[0]] }, "append_evidence", closed);
    const body = markerBlock(value.envelope, value.envelope.candidates[0]);
    refreshReader(value, [{ ...original, state: closed ? "CLOSED" : "OPEN", updatedAt: NOW.toISOString(), comments: [{ databaseId: 501, nodeId: "IC_501", body,
      author: "operator", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), deleted: false }] }]);
    const result = await runFileFindingCli({ ...value.input, ...captureRunners(value) });
    expect(result.metrics?.censusMode).toBe("reuse");
    const bundle = JSON.parse(readFileSync(value.censusPath, "utf8"));
    expect(bundle.intakeSnapshot.markerIndex[value.envelope.candidates[0].sourceFingerprint]).toMatchObject([
      { issueNumber: 1901, source: "comment", commentDatabaseId: 501 },
    ]);
    expect(bundle.intakePass.issues[0].comments[0].body).toBe(body);
    expect(bundle.intakeSnapshot.issues[0].state).toBe(closed ? "CLOSED" : "OPEN");
  });

  it("absorbs a pull request opened since capture without a full capture", async () => {
    const value = fixture(2);
    const original = censusIssue({ number: 1901, databaseId: 1901, nodeId: "I_1901" });
    installRefreshBundle(value, censusPass([original]));
    seedComplete({ ...value.envelope, candidates: [value.envelope.candidates[0]] }, "append_evidence");
    refreshReader(value, [{ ...original, updatedAt: NOW.toISOString() }], (body, endpoint) => endpoint.includes("issues?state=all")
      ? [...(body as unknown[]), { number: 2001, updated_at: NOW.toISOString(), pull_request: { url: "https://api.github.com/pulls/2001" } }]
      : body);
    const runners = captureRunners(value);
    const result = await runFileFindingCli({ ...value.input, ...runners });
    expect(result.metrics?.censusMode).toBe("reuse");
    expect(runners.runIntakePreflightCli).not.toHaveBeenCalled();
    const bundle = JSON.parse(readFileSync(value.censusPath, "utf8"));
    expect(bundle.intakePass.excludedPullRequestCount).toBe(1);
  });

  it.each(["unrelated comment", "closing field edit", "unexplained board", "Now", "moved into Now", "v2", "read failure"])(
    "falls back without a partial refresh publication: %s", async change => {
      const value = fixture(2);
      const original = censusIssue({ number: 1901, databaseId: 1901, nodeId: "I_1901" });
      const pass = censusPass([censusIssue(), original]);
      installRefreshBundle(value, pass);
      const bundle = JSON.parse(readFileSync(value.censusPath, "utf8"));
      // Align the starting board with the raw fixture, independently of the live response.
      bundle.boardFingerprint = censusBundle(bundle.intakeSnapshot, NOW).boardFingerprint;
      if (change === "v2") { bundle.schemaVersion = "github-issue-roadmap-shared-census/v2"; delete bundle.intakePass; delete bundle.intakeBookend; }
      if (change === "Now") {
        bundle.canonicalSnapshot = structuredClone(validCanonicalSnapshotV2([7, 1901]));
        bundle.canonicalSnapshot.repository = value.envelope.repository;
        for (const issue of bundle.canonicalSnapshot.issues) issue.identity.repository = value.envelope.repository;
        bundle.canonicalSnapshot.census.nowIssueNumbers = [1901];
        bundle.canonicalSnapshot.issues.find((issue: CanonicalSnapshotV2["issues"][number]) => issue.identity.number === 1901).v1.fieldValues = [
          { data_type: "single_select", issue_field_name: "Horizon", single_select_option: { name: "Now" } },
        ];
        const rebound = censusBundle(bundle.intakeSnapshot, NOW, bundle.canonicalSnapshot);
        bundle.intakeSnapshot = rebound.intakeSnapshot;
      }
      writeFileSync(value.censusPath, JSON.stringify(bundle));
      expect(() => sharedCensusStore.parseSharedCensusBundle(bundle, value.envelope.repository)).not.toThrow();
      seedComplete({ ...value.envelope, candidates: [value.envelope.candidates[0]] }, "append_evidence");
      let targeted = false;
      refreshReader(value, [pass.issues[0], { ...original, updatedAt: NOW.toISOString(),
        ...(change === "moved into Now" ? { fieldValues: [{ issue_field_name: "Horizon", data_type: "single_select", single_select_option: { name: "Now" } }] } : {}) }],
      (body, endpoint, read) => {
        if (endpoint.includes("/issues/1901")) targeted = true;
        if (change === "read failure" && targeted) throw new Error("targeted read failed");
        if (change === "unrelated comment" && targeted && endpoint.includes("issues?state=all")) {
          return (body as { number: number; updated_at: string }[]).map(row => row.number === 7 ? { ...row, updated_at: NOW.toISOString() } : row);
        }
        if (endpoint === "graphql" && (change === "unexplained board" || change === "closing field edit" && read > 2)) {
          const changed = body as { data: { repository: { issues: { nodes: { number: number; issueFieldValues: unknown }[] } } } };
          changed.data.repository.issues.nodes.find(issue => issue.number === 7)!.issueFieldValues = {
            totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [{ __typename: "IssueFieldSingleSelectValue", field: { name: "Priority" }, name: "P1" }],
          };
        }
        return body;
      });
      const before = readFileSync(value.censusPath);
      const runners = captureRunners(value);
      const capture = runners.runPreflightCli.getMockImplementation()!;
      runners.runPreflightCli.mockImplementation((...args) => { expect(readFileSync(value.censusPath)).toEqual(before); return capture(...args); });
      const result = await runFileFindingCli({ ...value.input, ...runners });
      expect(result.metrics?.censusMode).toBe("capture");
      expect(runners.runPreflightCli).toHaveBeenCalledOnce();
      expect(runners.runIntakePreflightCli).toHaveBeenCalledOnce();
      expect(result.metrics?.githubReads.boardCheck).toBe(2);
      expect(targeted).toBe(["unrelated comment", "closing field edit", "read failure"].includes(change));
    });
});

describe("U4a reuse eligibility", () => {
  it.each(["intakeSnapshot", "canonicalSnapshot", "boardFingerprint"])("refuses a foreign explicit bundle %s identity", async field => {
    const value = fixture();
    const before = readFileSync(value.censusPath);
    const bundle = JSON.parse(before.toString());
    if (field === "boardFingerprint") bundle[field].repositoryFullName = "Other/repo";
    else bundle[field].repository.databaseId = 999;
    const supplied = value.write("foreign.json", JSON.stringify(bundle));
    await expect(runFileFindingCli({ ...value.input, argv: [...value.input.argv, `--census=${supplied}`] }))
      .rejects.toThrow("census_repository_mismatch:");
    expect(value.input.runPreflightCli).not.toHaveBeenCalled();
    expect(value.input.runBoardCheckGh).not.toHaveBeenCalled();
    expect(readFileSync(value.censusPath)).toEqual(before);
  });

  it("returns the classified touched issue after intent resolves to a complete create", () => {
    const value = fixture();
    seedComplete(value.envelope);
    const journal = readJournal(resolveJournalPath("example-org/example-repo"));
    const result = checkCensusJournal({ recordCount: 0, lastRecordSha256: "empty" }, journal, "example-org/example-repo");
    expect(result).toEqual({ eligible: true, touchedIssueNumbers: [1901], createdIssueNumbers: [1901] });
    // A transition after the anchor must resolve with its earlier intent, too.
    expect(checkCensusJournal({ recordCount: 1, lastRecordSha256: canonicalJsonSha256(journal.records[0]) }, journal,
      "example-org/example-repo")).toEqual(result);
  });

  it("publishes a v3 bundle with raw census, fingerprint and pre-apply journal anchor", async () => {
    const value = fixture();
    const observation = { mode: "dry-run" };
    writeFileSync(resolveJournalPath("example-org/example-repo"), JSON.stringify(observation) + "\n");
    const runners = captureRunners(value);
    const result = await runFileFindingCli({ ...value.input, ...runners,
      argv: [...value.input.argv, "--fresh-census", "--execute"], operatorToken: "fixture-token" });
    expect(result.candidates[0].disposition).toBe("filed");
    const canonicalArgs = runners.runPreflightCli.mock.calls[0][0];
    const intakeArgs = runners.runIntakePreflightCli.mock.calls[0][0];
    const fingerprintPath = runners.outputPath(canonicalArgs, "fingerprint-out");
    expect(intakeArgs).toContain(`--fingerprint=${fingerprintPath}`);
    const bundle = JSON.parse(readFileSync(value.censusPath, "utf8"));
    expect(bundle).toMatchObject({ schemaVersion: "github-issue-roadmap-shared-census/v3",
      boardFingerprint: JSON.parse(readFileSync(fingerprintPath, "utf8")),
      journalPosition: { recordCount: 1, lastRecordSha256: canonicalJsonSha256(observation) } });
    expect(readJournal(resolveJournalPath("example-org/example-repo")).records).toHaveLength(4);
  }, 15000); // Real claim/journal fsyncs and capture publication can be slow on Windows.

  it.each([false, true])("detects an unrelated Priority edit (explicit=%s)", async explicit => {
    const value = fixture();
    const before = readFileSync(value.censusPath);
    const read = value.input.runBoardCheckGh.getMockImplementation()!;
    value.input.runBoardCheckGh.mockImplementation(args => read(args).replace('"totalCount":0,"nodes":[]',
      '"totalCount":1,"nodes":[{"__typename":"IssueFieldSingleSelectValue","name":"P1","field":{"name":"Priority"}}]'));
    const runners = captureRunners(value);
    const input = { ...value.input, ...runners, argv: [...value.input.argv, ...(explicit ? [`--census=${value.censusPath}`] : [])] };
    if (explicit) {
      await expect(runFileFindingCli(input)).rejects.toThrow("census_stale:");
      expect(readFileSync(value.censusPath)).toEqual(before);
      expect(runners.runPreflightCli).not.toHaveBeenCalled();
    } else expect((await runFileFindingCli(input)).metrics?.censusMode).toBe("capture");
  });

  it("reuses when the REST index writes Z where the stored snapshot writes .000Z", async () => {
    const value = fixture();
    const read = value.input.runBoardCheckGh.getMockImplementation()!;
    value.input.runBoardCheckGh.mockImplementation(args => args.includes("graphql") ? read(args) : read(args).replace(/\.000Z/g, "Z"));
    expect(read(["api", "/repos/example-org/example-repo/issues?state=all&per_page=100"])).toContain(".000Z");
    const result = await runFileFindingCli(value.input);
    expect(result.metrics?.censusMode).toBe("reuse");
    expect(value.input.runPreflightCli).not.toHaveBeenCalled();
  });

  it("detects an edited closed issue through the all-issue index", async () => {
    const value = fixture();
    value.publishCensus(stackSnapshot(value.envelope, censusPass([censusIssue({ state: "CLOSED" })])));
    const read = value.input.runBoardCheckGh.getMockImplementation()!;
    value.input.runBoardCheckGh.mockImplementation(args => read(args).replace("2026-08-20T11:00:00.000Z", "2026-08-20T11:55:00.000Z"));
    const runners = captureRunners(value);
    expect((await runFileFindingCli({ ...value.input, ...runners })).metrics?.censusMode).toBe("capture");
    expect(runners.runIntakePreflightCli).toHaveBeenCalledOnce();
  });

  it.each(["appeared", "disappeared"])("recaptures when a closed issue %s outside the journal", async change => {
    const value = fixture();
    const snapshot = stackSnapshot(value.envelope, censusPass([censusIssue({ state: "CLOSED" })]));
    value.publishCensus(snapshot);
    const extra = { ...snapshot.issues[0], number: 999, identity: { ...snapshot.issues[0].identity, number: 999 } };
    const indexed = change === "appeared" ? [...snapshot.issues, extra] : [];
    const read = value.input.runBoardCheckGh.getMockImplementation()!;
    value.input.runBoardCheckGh.mockImplementation(args => args.includes("graphql") ? read(args) : boardCheckResponse(indexed, args));
    const runners = captureRunners(value);
    expect((await runFileFindingCli({ ...value.input, ...runners })).metrics?.censusMode).toBe("capture");
    expect(runners.runIntakePreflightCli).toHaveBeenCalledOnce();
  });

  it("counts fingerprint and index reads on unchanged reuse", async () => {
    const value = fixture();
    const result = await runFileFindingCli(value.input);
    expect(result.metrics?.githubReads.boardCheck).toBe(2);
    expect(value.input.runBoardCheckGh.mock.calls[0][0]).toContain("graphql");
    expect(value.input.runBoardCheckGh.mock.calls[1][0].join(" ")).toContain("state=all");
    expect(value.input.runPreflightCli).not.toHaveBeenCalled();
    expect(value.input.runIntakePreflightCli).not.toHaveBeenCalled();
  });

  it.each([15, 25])("requires twenty minutes of novelty headroom (%s minutes left)", async minutesLeft => {
    const value = fixture();
    const now = () => new Date(Date.parse("2026-08-20T13:00:00.000Z") - minutesLeft * 60_000);
    const runners = captureRunners(value, now);
    const result = await runFileFindingCli({ ...value.input, ...runners, now });
    expect(result.metrics?.censusMode).toBe(minutesLeft < 20 ? "capture" : "reuse");
    expect(runners.runPreflightCli).toHaveBeenCalledTimes(minutesLeft < 20 ? 1 : 0);
  });

  it("forces a cold capture and publishes it", async () => {
    const value = fixture();
    const before = readFileSync(value.censusPath);
    const runners = captureRunners(value);
    const result = await runFileFindingCli({ ...value.input, ...runners, argv: [...value.input.argv, "--fresh-census"] });
    expect(result.metrics?.censusMode).toBe("capture");
    expect(runners.runIntakePreflightCli).toHaveBeenCalledOnce();
    expect(readFileSync(value.censusPath)).not.toEqual(before);
    expect(value.input.runBoardCheckGh).not.toHaveBeenCalled();
  });

  it("refuses to refresh an explicit census that predates a pipeline create", async () => {
    const value = fixture(2);
    const pass = installRefreshBundle(value, censusPass());
    value.write("finding.roadmap-outcomes.json", JSON.stringify({ ...value.envelope, candidates: [value.envelope.candidates[0]] }));
    expect((await value.execute()).candidates[0].disposition).toBe("filed");
    const created = censusIssue({ number: 1901, databaseId: 1901, nodeId: "I_1901", updatedAt: NOW.toISOString(),
      body: markerBlock(value.envelope, value.envelope.candidates[0]) });
    refreshReader(value, [...pass.issues, created]);
    const before = readFileSync(value.censusPath);
    value.write("finding.roadmap-outcomes.json", JSON.stringify({ ...value.envelope, candidates: [value.envelope.candidates[1]] }));
    const runners = captureRunners(value);
    await expect(runFileFindingCli({ ...value.input, ...runners, argv: [...value.input.argv, `--census=${value.censusPath}`] }))
      .rejects.toThrow("census_stale: explicit census predates pipeline writes");
    expect(readFileSync(value.censusPath)).toEqual(before);
    expect(runners.runPreflightCli).not.toHaveBeenCalled();
  });

  it("refreshes after a completed create, retains evidence age, and reuses the new journal anchor", async () => {
    const value = fixture(2);
    const initialPass = censusPass();
    const pass = installRefreshBundle(value, { ...initialPass, receipts: [...initialPass.receipts,
      { ...initialPass.receipts[1], endpoint: "/repos/example-org/example-repo/issues/comments?per_page=100", page: 1 },
      { ...initialPass.receipts[1], endpoint: "/repos/example-org/example-repo/issues/comments?per_page=100", page: 2 },
    ] });
    value.write("finding.roadmap-outcomes.json", JSON.stringify({ ...value.envelope, candidates: [value.envelope.candidates[0]] }));
    expect((await value.execute()).candidates[0].disposition).toBe("filed");
    const journal = readJournal(resolveJournalPath("example-org/example-repo"));
    expect(journal.records.map(row => (row as { event: string }).event)).toEqual(["intent", "created", "complete"]);
    const created = censusIssue({ number: 1901, databaseId: 1901, nodeId: "I_1901", updatedAt: NOW.toISOString(),
      body: markerBlock(value.envelope, value.envelope.candidates[0]) });
    refreshReader(value, [...pass.issues, created]);
    value.write("finding.roadmap-outcomes.json", JSON.stringify({ ...value.envelope, candidates: [value.envelope.candidates[1]] }));
    const runners = captureRunners(value);
    const result = await runFileFindingCli({ ...value.input, ...runners });
    expect(result.metrics?.censusMode).toBe("reuse");
    expect(runners.runPreflightCli).not.toHaveBeenCalled();
    expect(runners.runIntakePreflightCli).not.toHaveBeenCalled();
    expect(result.metrics?.githubReads).toMatchObject({ boardCheck: 2, targetedRefresh: 5, canonical: 0, intake: 0 });
    const bundle = JSON.parse(readFileSync(value.censusPath, "utf8"));
    expect(bundle.intakeSnapshot.census).toMatchObject({ expectedIssueCount: 2, issueCount: 2, completedAt: pass.completedAt });
    expect(bundle.intakePass.receipts.slice(0, pass.receipts.length)).toEqual(pass.receipts);
    expect(bundle.intakeSnapshot.markerIndex[value.envelope.candidates[0].sourceFingerprint]).toMatchObject([{ issueNumber: 1901, source: "body" }]);
    expect(bundle.intakeBookend.updatedAt).toEqual({ 7: pass.issues[0].updatedAt, 1901: created.updatedAt });
    expect(bundle.journalPosition).toEqual({ recordCount: 3, lastRecordSha256: canonicalJsonSha256(journal.records.at(-1)) });
    expect(() => intakeShadow.assertIntakeSnapshotFreshForShadow(bundle.intakeSnapshot, NOW)).not.toThrow();
    expect(() => intakeShadow.assertIntakeSnapshotFreshForShadow(bundle.intakeSnapshot, new Date("2026-08-20T13:00:01.000Z"))).toThrow();
    const evidenceRoot = join(result.runRoot, "artifacts/github-issue-roadmap");
    expect(verifyRunEvidence({ evidenceBytes: readFileSync(join(evidenceRoot, "run-evidence.json")),
      plan: JSON.parse(readFileSync(join(evidenceRoot, "approval-plan.json"), "utf8")), repository: "example-org/example-repo",
      files: name => readFileSync(join(evidenceRoot, name)),
    }).ok).toBe(true);
    value.input.runBoardCheckGh.mockClear();
    const third = await runFileFindingCli({ ...value.input, ...runners });
    expect(third.metrics?.censusMode).toBe("reuse");
    expect(third.metrics?.githubReads).toEqual({ canonical: 0, intake: 0, boardCheck: 2 });
    expect(value.input.runBoardCheckGh).toHaveBeenCalledTimes(2);
  });

  it.each(["shorter", "changed anchor", "tail", "malformed", "unresolved intent"])("recaptures for journal %s", async kind => {
    const value = fixture();
    const journalPath = resolveJournalPath("example-org/example-repo");
    const observation = { mode: "dry-run", repository: "example-org/example-repo" };
    writeFileSync(journalPath, JSON.stringify(observation) + "\n");
    value.publishCensus(value.census);
    if (kind === "shorter") writeFileSync(journalPath, "");
    if (kind === "changed anchor") writeFileSync(journalPath, JSON.stringify({ ...observation, note: "changed" }) + "\n");
    if (kind === "tail") writeFileSync(journalPath, JSON.stringify(observation) + "\n{");
    if (kind === "malformed") writeFileSync(journalPath, JSON.stringify(observation) + "\n{\n");
    if (kind === "unresolved intent") {
      seedComplete(stackEnvelope());
      const records = readJournal(journalPath).records;
      writeFileSync(journalPath, records.slice(0, 2).map(row => JSON.stringify(row)).join("\n") + "\n");
    }
    const runners = captureRunners(value);
    // Stop at assessment: malformed history remains apply's separate refusal contract.
    value.caller.mockRejectedValue(new Error("assessment reached"));
    await expect(runFileFindingCli({ ...value.input, ...runners })).rejects.toThrow("assessment reached");
    expect(runners.runIntakePreflightCli).toHaveBeenCalledOnce();
  });

  it.each([{ mode: "dry-run" }, { mode: "execute", executed: false }])("ignores non-write journal observations %j", async observation => {
    const value = fixture();
    writeFileSync(resolveJournalPath("example-org/example-repo"), JSON.stringify(observation) + "\n");
    const result = await runFileFindingCli(value.input);
    expect(result.metrics?.censusMode).toBe("reuse");
    expect(value.input.runPreflightCli).not.toHaveBeenCalled();
  });

  it("refuses an explicit stale census without replacing the store", async () => {
    const value = fixture();
    const before = readFileSync(value.censusPath);
    const supplied = value.write("explicit.json", before.toString());
    const runners = captureRunners(value);
    const resultPath = join(value.root, "refused.json");
    expect(await runFileFindingCommand({ ...value.input, ...runners,
      now: () => new Date("2026-08-20T13:00:01.000Z"),
      argv: [...value.input.argv, `--census=${supplied}`, `--result=${resultPath}`] })).toBe(1);
    expect(JSON.parse(readFileSync(resultPath, "utf8")).candidates[0]).toMatchObject({
      reason: expect.stringContaining("census_stale:"), fixingCommand: expect.stringContaining("run-github-issue-roadmap-file-finding.ps1"),
    });
    expect(runners.runPreflightCli).not.toHaveBeenCalled();
    expect(readFileSync(value.censusPath)).toEqual(before);
  });

  it("carries a secondary rate limit reset through the refusal and wait advice", async () => {
    const value = fixture();
    const before = readFileSync(value.censusPath);
    const runners = captureRunners(value);
    runners.runIntakePreflightCli.mockImplementation(() => { throw new Error(JSON.stringify({ status: "blocked",
      blocker: { code: "rate_limited", resetEpoch: "1787230800" } })); });
    const resultPath = join(value.root, "limited.json");
    expect(await runFileFindingCommand({ ...value.input, ...runners,
      now: () => new Date("2026-08-20T13:00:01.000Z"), argv: [...value.input.argv, `--result=${resultPath}`] })).toBe(1);
    const candidate = JSON.parse(readFileSync(resultPath, "utf8")).candidates[0];
    const reset = new Date(1787230800 * 1000).toISOString();
    expect(candidate.reason).toContain(`census_unavailable:`);
    expect(candidate.reason).toContain(reset);
    expect(candidate.fixingCommand).toContain(`Wait until ${reset}`);
    expect(readFileSync(value.censusPath)).toEqual(before);
  });
});

function seedComplete(envelope: OutcomeEnvelope, action: "create_issue" | "append_evidence" = "create_issue", closed = false) {
  const path = resolveJournalPath("example-org/example-repo");
  const claim = acquireExecutionClaim(path, { mode: "execute" });
  try {
    for (const [index, candidate] of envelope.candidates.entries()) {
      const body = markerBlock(envelope, candidate);
      for (const event of ["intent", "created", "complete"] as const) {
        claim.withOwnership(() => appendJournal(path, executionEvent({ event, now: NOW, decisionContentSha256: "d".repeat(64),
          write: { sourceFingerprint: candidate.sourceFingerprint, repository: "example-org/example-repo", action, actions: closed ? [action, "close_issue"] : [action],
            canonicalIssueNumber: action === "create_issue" ? null : 1901 + index,
            issue: action === "create_issue" ? { title: candidate.outcome.title, body } : null,
            evidenceComment: action === "append_evidence" ? body : null,
            closeIssue: closed ? { targetIssueNumber: 1901 + index, before: "OPEN", after: "CLOSED", evidenceIds: ["evidence-current"] } : null,
            classifications: [], suggestedHorizon: null },
          issueNumber: event === "intent" && action === "create_issue" ? null : 1901 + index,
          issueId: event === "intent" ? null : `I_${1901 + index}`,
          commentId: action === "append_evidence" && event !== "intent" ? `C_${index}` : null,
        })));
      }
    }
  } finally { claim.release(); }
}

function terminalEnvelope(envelope: OutcomeEnvelope, artifact = envelope.artifact.stableId) {
  return createOutcomeEnvelope({ ...envelope, schemaVersion: OUTCOME_ENVELOPE_SCHEMA_VERSION_V2,
    artifact: { ...envelope.artifact, stableId: artifact },
    candidates: envelope.candidates.map(({ sourceFingerprint: _s, emissionContentSha256: _e, ...candidate }, index) => ({
      ...candidate, ...(index === 0 ? { disposition: { kind: "achieved" as const, commits: [{ sha: MAIN }], note: "Done." } } : {}),
    })) });
}

function mainDisposition(value: ReturnType<typeof fixture>, envelope = terminalEnvelope(value.envelope)) {
  value.input.dispositionHistory = ref => dispositionHistory(ref, { repoRoot: value.root, runGit: value.input.runGit });
  const ordinary = value.input.runGit.getMockImplementation()!;
  value.input.runGit.mockImplementation((cwd, args) => {
    if (args[0] === "log" && args.includes("--raw")) return `${MAIN}\n:000000 100644 ${"0".repeat(40)} ${"b".repeat(40)} A\tartifacts/github-issue-roadmap/history.roadmap-outcomes.json\n`;
    if (args[0] === "cat-file" && args[2] === "b".repeat(40)) return Buffer.from(JSON.stringify(envelope)).toString("base64");
    return ordinary(cwd, args);
  });
}

// Immutable fixture commits behind the injected Git runner; no real Git writes.
function movingMain(value: ReturnType<typeof fixture>) {
  type Commit = { parent?: string; files: Record<string, string>; sidecar?: OutcomeEnvelope };
  const commits = new Map<string, Commit>([[MAIN, { files: {} }]]);
  let current = MAIN;
  const git = value.input.runGit.getMockImplementation()!;
  value.input.runGit.mockImplementation((cwd, args) => {
    if (args[0] === "rev-parse" && args[2] === "origin/main^{commit}") return current;
    if (args[0] === "rev-parse") {
      const sha = args[2]?.replace(/\^\{commit\}$/, "");
      if (commits.has(sha)) return sha;
    }
    if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
      for (let sha: string | undefined = args[3]; sha !== undefined; sha = commits.get(sha)?.parent) {
        if (sha === args[2]) return "";
      }
      throw new Error("Not an ancestor");
    }
    if (args[0] === "ls-tree") {
      const sha = args.find(arg => commits.has(arg));
      if (sha !== undefined) return Object.keys(commits.get(sha)!.files).join("\n");
    }
    if (args[0] === "show") {
      const [sha, path] = args.at(-1)!.split(":");
      const contents = commits.get(sha)?.files[path];
      if (contents !== undefined) return contents;
    }
    if (args[0] === "grep") {
      const sha = args.find(arg => commits.has(arg));
      if (sha !== undefined) return Object.entries(commits.get(sha)!.files)
        .map(([path, contents]) => `${sha}:${path}:1:${contents}`).join("\n");
    }
    if (args[0] === "log" && args.includes("--raw")) {
      const sha = args.find(arg => commits.has(arg));
      const rows: string[] = [];
      for (let at = sha; at !== undefined; at = commits.get(at)?.parent) {
        if (commits.get(at)?.sidecar !== undefined) rows.unshift(`${at}\n:000000 100644 ${"0".repeat(40)} ${at} A\tartifacts/github-issue-roadmap/${at}.roadmap-outcomes.json\n`);
      }
      return rows.join("");
    }
    if (args[0] === "log") return args.find(arg => commits.has(arg)) ?? current;
    if (args[0] === "cat-file" && args[1] === "blob" && commits.get(args[2])?.sidecar !== undefined) {
      return Buffer.from(JSON.stringify(commits.get(args[2])!.sidecar)).toString("base64");
    }
    return git(cwd, args);
  });
  value.input.dispositionHistory = ref => dispositionHistory(ref, { repoRoot: value.root, runGit: value.input.runGit });
  return {
    add(sha: string, changes: Record<string, string>, sidecar?: OutcomeEnvelope, parent: string | undefined = MAIN) {
      commits.set(sha, { parent, files: { ...commits.get(parent ?? "")?.files, ...changes }, sidecar });
    },
    move(sha: string) { current = sha; },
    duringAssessment(sha: string) {
      const caller = value.caller.getMockImplementation()!;
      value.caller.mockImplementation(async call => { current = sha; return caller(call); });
    },
    afterShadow(sha: string) {
      const shadow = intakeShadow.runIntakeShadow;
      vi.spyOn(intakeShadow, "runIntakeShadow").mockImplementation(input => {
        const result = shadow(input);
        current = sha;
        return result;
      });
    },
  };
}

describe("terminal disposition admission", () => {
  it("dry-runs exactly five active candidates and reports two dispositioned siblings", async () => {
    const value = fixture(7, undefined, 2);
    const result = await runFileFindingCli(value.input);
    expect(result.candidates.map(candidate => candidate.disposition)).toEqual(["dry-run", "dry-run", "dry-run", "dry-run", "dry-run", "dispositioned", "dispositioned"]);
    expect((value.caller.mock.calls[0][0].evidence.candidateEnvelope as OutcomeEnvelope).candidates).toEqual(value.envelope.candidates.slice(0, 5));
    expect(result.candidates.slice(0, 5).every(candidate => candidate.disposition === "dry-run" && candidate.projectedAction === "create_issue")).toBe(true);
    value.untouchedTransport();
  });

  it("admits six own-active candidates when another artifact dispositioned one on main", async () => {
    const value = fixture(6);
    mainDisposition(value, terminalEnvelope(value.envelope, "different-main-artifact"));
    const result = await runFileFindingCli(value.input);
    expect(result.candidates.map(candidate => candidate.disposition)).toEqual(["dispositioned", "dry-run", "dry-run", "dry-run", "dry-run", "dry-run"]);
    expect(value.caller).toHaveBeenCalledOnce();
    expect((value.caller.mock.calls[0][0].evidence.candidateEnvelope as OutcomeEnvelope).candidates).toEqual(value.envelope.candidates.slice(1));
    value.untouchedTransport();
  });

  it("keeps the production history default fail closed without origin/main and writes nothing", async () => {
    const value = fixture();
    const { dispositionHistory: _history, ...input } = value.input;
    const before = files(value.root);
    await expect(runFileFindingCli({ ...input, runGit: runCredentialCleanGit,
      argv: [...input.argv, "--execute"], operatorToken: "test-token" }))
      .rejects.toThrow("disposition_history_unavailable: cannot read origin/main.");
    expect(files(value.root)).toEqual(before);
    expect(value.caller).not.toHaveBeenCalled();
    value.untouchedTransport();
  });

  it.each(["own", "main", "different-artifact", "already-filed"])("skips a %s candidate before assessment or transport", async kind => {
    const value = fixture();
    if (kind === "own") writeFileSync(value.candidatePath, JSON.stringify(terminalEnvelope(value.envelope)));
    else mainDisposition(value, terminalEnvelope(value.envelope, kind === "different-artifact" ? "other-artifact" : value.envelope.artifact.stableId));
    if (kind === "already-filed") seedComplete(value.envelope);
    unlinkSync(value.censusPath);
    const result = await value.execute();
    expect(result.candidates).toMatchObject([{ stableOutcomeId: value.envelope.candidates[0].stableOutcomeId, disposition: "dispositioned" }]);
    expect(fileFindingExitCode(result)).toBe(0);
    expect(value.caller).not.toHaveBeenCalled();
    expect(value.input.runGit.mock.calls.some(([, args]) => args.includes("HEAD^{commit}"))).toBe(false);
    value.untouchedTransport();
  });

  it.each(["own", "main"])("files only the active member of a mixed %s envelope with one result per original candidate", async kind => {
    const value = fixture(2);
    if (kind === "own") writeFileSync(value.candidatePath, JSON.stringify(terminalEnvelope(value.envelope)));
    else mainDisposition(value);
    const result = await value.execute();
    expect(result.candidates.map(candidate => candidate.disposition)).toEqual(["dispositioned", "filed"]);
    expect(result.candidates.map(candidate => candidate.stableOutcomeId)).toEqual(value.envelope.candidates.map(candidate => candidate.stableOutcomeId));
    expect(value.transport.createIssue).toHaveBeenCalledOnce();
    expect((value.caller.mock.calls[0][0].evidence.candidateEnvelope as OutcomeEnvelope).candidates)
      .toEqual([value.envelope.candidates[1]]);
  });

  it("refuses an unreadable origin/main with a named result and no assessment or transport", async () => {
    const value = fixture();
    const ordinary = value.input.runGit.getMockImplementation()!;
    value.input.runGit.mockImplementation((cwd, args) => {
      if (args.includes("origin/main^{commit}")) throw new Error("Missing remote ref");
      return ordinary(cwd, args);
    });
    const resultPath = join(value.root, "result.json");
    expect(await runFileFindingCommand({ ...value.input, dispositionHistory: undefined, argv: [...value.input.argv, `--result=${resultPath}`, "--execute"], operatorToken: "test" })).toBe(1);
    expect(JSON.parse(readFileSync(resultPath, "utf8")).candidates).toMatchObject([
      { disposition: "refused", reason: expect.stringContaining("disposition_history_unavailable:") },
    ]);
    expect(value.caller).not.toHaveBeenCalled();
    value.untouchedTransport();
  });
});

describe("criteria authorship admission", () => {
  function criteriaFinding() {
    const value = fixture(2);
    const envelope = createOutcomeEnvelope({ ...value.envelope, schemaVersion: OUTCOME_ENVELOPE_SCHEMA_VERSION_V2,
      candidates: value.envelope.candidates.map(({ sourceFingerprint: _s, emissionContentSha256: _e, ...candidate }, index) => ({
        ...candidate, ...(index === 1 ? { acceptanceCriteria: ["The operator can see the completed behavior."] } : {}),
      })) });
    writeFileSync(value.candidatePath, prettyCanonicalJson(envelope));
    return { ...value, envelope };
  }

  it("resolves criteria once at the disposition history SHA before any transport call", async () => {
    const value = criteriaFinding();
    const outcome = value.envelope.candidates[1];
    const history = vi.fn<typeof dispositionHistory>(() => new Map());
    const authorship = vi.fn<CriteriaAuthorshipLookup>(() => "unknown");
    const result = await runFileFindingCli({ ...value.input,
      argv: [...value.input.argv, "--execute"], operatorToken: "fixture-token",
      dispositionHistory: history, criteriaAuthorship: authorship,
      openTransport: () => {
        expect(authorship).toHaveBeenCalledOnce();
        return value.openTransport();
      },
    });
    expect(history.mock.calls[0]).toEqual([MAIN, { repoRoot: value.root, runGit: value.input.runGit }]);
    expect(authorship).toHaveBeenCalledExactlyOnceWith(outcome.sourceFingerprint, outcome.emissionContentSha256,
      MAIN, { repoRoot: value.root, runGit: value.input.runGit });
    expect(result.candidates.map(candidate => candidate.disposition)).toEqual(["filed", "filed"]);
    expect(value.transport.createIssue).toHaveBeenCalledTimes(2);
    const evidenceRoot = join(result.runRoot, "artifacts/github-issue-roadmap");
    expect(JSON.parse(readFileSync(join(evidenceRoot, "run-evidence.json"), "utf8")).decisions[0].candidateAnnotations).toBeUndefined();
    expect(JSON.parse(readFileSync(join(evidenceRoot, "run-evidence-1.json"), "utf8")).decisions[0].candidateAnnotations).toEqual([{
      sourceFingerprint: outcome.sourceFingerprint, emissionContentSha256: outcome.emissionContentSha256, criteriaAuthorship: "unknown",
    }]);
  });

  it("makes no transport call when the second candidate's authorship lookup throws", async () => {
    const value = criteriaFinding();
    const outcome = value.envelope.candidates[1];
    const authorship = vi.fn<CriteriaAuthorshipLookup>(() => {
      throw new Error("disposition_history_unavailable: criteria history cannot be read.");
    });
    await expect(runFileFindingCli({ ...value.input, criteriaAuthorship: authorship,
      argv: [...value.input.argv, "--execute"], operatorToken: "fixture-token" }))
      .rejects.toThrow("disposition_history_unavailable: criteria history cannot be read.");
    expect(value.envelope.candidates[0].acceptanceCriteria).toBeUndefined();
    expect(authorship).toHaveBeenCalledExactlyOnceWith(outcome.sourceFingerprint, outcome.emissionContentSha256,
      MAIN, { repoRoot: value.root, runGit: value.input.runGit });
    value.untouchedTransport();
  });

  it("refuses before transport when existence and disposition history resolved different SHAs", async () => {
    const value = criteriaFinding();
    const fresh = "c".repeat(40);
    const main = movingMain(value);
    main.add(fresh, {}, terminalEnvelope(value.envelope));
    main.duringAssessment(fresh);
    const authorship = vi.fn<CriteriaAuthorshipLookup>(() => "unknown");
    await expect(runFileFindingCli({ ...value.input, criteriaAuthorship: authorship,
      argv: [...value.input.argv, "--execute"], operatorToken: "fixture-token" }))
      .rejects.toThrow(`disposition_history_drifted: origin/main changed from ${MAIN} to ${fresh} before apply; rerun filing.`);
    expect(authorship).toHaveBeenCalledWith(value.envelope.candidates[1].sourceFingerprint,
      value.envelope.candidates[1].emissionContentSha256, MAIN, expect.anything());
    value.untouchedTransport();
  });
});

describe("candidate-scoped main re-pin", () => {
  const fresh = "c".repeat(40);
  const second = "d".repeat(40);
  const drift = `disposition_history_drifted: origin/main changed from ${MAIN} to ${fresh} before apply; rerun filing.`;

  it.each(["assessment", "pre-apply"])("accepts a docs-only descendant at %s and applies at the new SHA", async timing => {
    const value = fixture();
    const main = movingMain(value);
    main.add(fresh, { "docs/filing-note.md": "Documentation only.\n" });
    if (timing === "assessment") main.duringAssessment(fresh);
    else main.afterShadow(fresh);
    const apply = vi.spyOn(intakeApply, "runIntakeApplyCli");
    const probe = vi.spyOn(existenceProbe, "probeExistenceAtSha");
    const result = await value.execute();
    expect(result.candidates[0].disposition).toBe("filed");
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0][0].argv).toContain(`--origin-main-sha=${fresh}`);
    expect(value.input.runGit).toHaveBeenCalledWith(value.root, ["merge-base", "--is-ancestor", MAIN, fresh], expect.anything());
    // Apply also performs its existing independent immutable-SHA probe.
    expect(probe).toHaveBeenCalledTimes(timing === "pre-apply" ? 2 : 1);
    if (timing === "pre-apply") expect(probe.mock.calls[0][0]).toMatchObject({ originMainSha: fresh });
  });

  it("accepts an unrelated fingerprint's disposition on a descendant", async () => {
    const value = fixture();
    const main = movingMain(value);
    const unrelated = terminalEnvelope(createOutcomeEnvelope({ ...value.envelope,
      candidates: value.envelope.candidates.map(({ sourceFingerprint: _s, emissionContentSha256: _e, ...candidate }) => ({
        ...candidate, stableOutcomeId: "unrelated-outcome",
      })),
    }), "other-artifact");
    expect(unrelated.candidates[0].sourceFingerprint).not.toBe(value.envelope.candidates[0].sourceFingerprint);
    main.add(fresh, {}, unrelated);
    main.duringAssessment(fresh);
    const apply = vi.spyOn(intakeApply, "runIntakeApplyCli");
    expect((await value.execute()).candidates[0].disposition).toBe("filed");
    expect(apply.mock.calls[0][0].argv).toContain(`--origin-main-sha=${fresh}`);
  });

  it("refuses a disposition under a candidate's stableOutcomeId", async () => {
    const value = fixture();
    const main = movingMain(value);
    main.add(fresh, {}, terminalEnvelope(value.envelope));
    main.duringAssessment(fresh);
    await expect(value.execute()).rejects.toThrow(drift);
    value.untouchedTransport();
  });

  it("refuses another artifact's disposition for an original candidate already filtered as replayed", async () => {
    const value = fixture(2);
    seedComplete({ ...value.envelope, candidates: [value.envelope.candidates[0]] });
    value.publishCensus(value.census);
    const main = movingMain(value);
    main.add(fresh, {}, terminalEnvelope(value.envelope, "another-artifact"));
    main.duringAssessment(fresh);
    await expect(value.execute()).rejects.toThrow(drift);
    expect((value.caller.mock.calls[0][0].evidence.candidateEnvelope as OutcomeEnvelope).candidates)
      .toEqual([value.envelope.candidates[1]]);
    value.untouchedTransport();
  });

  it("compares all disposition entries even when the original split is unchanged", async () => {
    const value = fixture(2, undefined, 1);
    const main = movingMain(value);
    const sibling = { ...value.envelope, candidates: [value.envelope.candidates[1]] };
    main.add(fresh, {}, terminalEnvelope(sibling, "another-artifact"));
    main.duringAssessment(fresh);
    await expect(value.execute()).rejects.toThrow(drift);
    value.untouchedTransport();
  });

  it("refuses a changed active/dispositioned split independently of entry equality", async () => {
    const value = fixture(2);
    const main = movingMain(value);
    main.add(fresh, { "docs/note.md": "No history entries changed." });
    main.duringAssessment(fresh);
    const next = dispositionHistory(fresh, { repoRoot: value.root, runGit: value.input.runGit });
    const select = dispositionSelection.effectiveOutcomeCandidates;
    vi.spyOn(dispositionSelection, "effectiveOutcomeCandidates").mockImplementation((envelope, history) =>
      history === next ? { active: [envelope.candidates[1]], dispositioned: [envelope.candidates[0]] } : select(envelope, history));
    await expect(value.execute()).rejects.toThrow(drift);
    value.untouchedTransport();
  });

  it("rechecks the original envelope budget at the new history", async () => {
    const value = fixture();
    const main = movingMain(value);
    main.add(fresh, { "docs/note.md": "No history entries changed." });
    main.duringAssessment(fresh);
    const next = dispositionHistory(fresh, { repoRoot: value.root, runGit: value.input.runGit });
    const check = intakeAssessment.assertEffectiveIntakeEnvelopeBudgets;
    vi.spyOn(intakeAssessment, "assertEffectiveIntakeEnvelopeBudgets").mockImplementation((raw, envelope, history) => {
      if (history === next) throw new Error("Fixture new-history budget refusal");
      return check(raw, envelope, history);
    });
    await expect(value.execute()).rejects.toThrow(drift);
    value.untouchedTransport();
  });

  it("refuses a non-descendant force-push", async () => {
    const value = fixture();
    const main = movingMain(value);
    main.add(fresh, { "docs/note.md": "Unrelated root." }, undefined, "a".repeat(40));
    main.duringAssessment(fresh);
    await expect(value.execute()).rejects.toThrow(drift);
    value.untouchedTransport();
  });

  it.each(["assessment", "pre-apply"])("refuses changed criteria authorship at %s against the admission baseline", async timing => {
    const value = fixture();
    const envelope = createOutcomeEnvelope({ ...value.envelope, schemaVersion: OUTCOME_ENVELOPE_SCHEMA_VERSION_V2,
      candidates: value.envelope.candidates.map(({ sourceFingerprint: _s, emissionContentSha256: _e, ...candidate }) => ({
        ...candidate, acceptanceCriteria: ["The operator can see the completed behavior."],
      })),
    });
    value.write("finding.roadmap-outcomes.json", prettyCanonicalJson(envelope));
    const main = movingMain(value);
    main.add(fresh, {});
    if (timing === "assessment") main.duringAssessment(fresh);
    else main.afterShadow(fresh);
    const authorship = vi.fn<CriteriaAuthorshipLookup>((_fingerprint, _emission, ref) => ref === MAIN ? "unknown"
      : { introducingCommit: fresh, criteriaSha256: canonicalJsonSha256(envelope.candidates[0].acceptanceCriteria) });
    value.input.criteriaAuthorship = authorship;
    await expect(value.execute()).rejects.toThrow(drift);
    expect(authorship.mock.calls.map(call => call[2])).toEqual([MAIN, fresh]);
    expect(authorship.mock.invocationCallOrder[0]).toBeLessThan(value.caller.mock.invocationCallOrder[0]);
    value.untouchedTransport();
  });

  it("refuses a second code-only move before apply after one successful re-pin", async () => {
    const value = fixture();
    const main = movingMain(value);
    main.add(fresh, { "docs/note.md": "Safe first merge." });
    main.add(second, { "src/unrelated.ts": "export const unrelated = true;" }, undefined, fresh);
    main.duringAssessment(fresh);
    main.afterShadow(second);
    await expect(value.execute()).rejects.toThrow(`disposition_history_drifted: origin/main changed from ${fresh} to ${second}`);
    value.untouchedTransport();
  });

  it("retains the one-re-pin limit across a census refresh and reassessment", async () => {
    const value = fixture();
    const main = movingMain(value);
    main.add(fresh, { "docs/first.md": "First merge." });
    main.add(second, { "src/unrelated.ts": "export const unrelated = true;" }, undefined, fresh);
    const now = vi.fn(() => NOW);
    const runners = captureRunners(value, now);
    const caller = value.caller.getMockImplementation()!;
    value.caller.mockImplementation(async call => {
      main.move(value.caller.mock.calls.length === 1 ? fresh : second);
      return caller(call);
    });
    const shadow = intakeShadow.runIntakeShadow;
    vi.spyOn(intakeShadow, "runIntakeShadow").mockImplementation(input => {
      const result = shadow(input);
      now.mockReturnValue(new Date("2026-08-20T13:00:01.000Z"));
      return result;
    });
    await expect(runFileFindingCli({ ...value.input, ...runners, now,
      argv: [...value.input.argv, "--execute"], operatorToken: "fixture-token" }))
      .rejects.toThrow(`disposition_history_drifted: origin/main changed from ${fresh} to ${second}`);
    expect(value.caller).toHaveBeenCalledTimes(2);
    value.untouchedTransport();
  });

  it("re-pins before a later sibling without applying a completed candidate twice", async () => {
    const value = fixture(2);
    const main = movingMain(value);
    main.add(fresh, { "docs/late.md": "Merged after the first create." });
    const create = value.transport.createIssue.getMockImplementation()!;
    value.transport.createIssue.mockImplementation(async () => {
      main.move(fresh);
      return create();
    });
    const apply = vi.spyOn(intakeApply, "runIntakeApplyCli");
    const result = await value.execute();
    expect(result.candidates.map(candidate => candidate.disposition)).toEqual(["filed", "filed"]);
    expect(value.transport.createIssue).toHaveBeenCalledTimes(2);
    expect(value.caller).toHaveBeenCalledOnce();
    expect(apply.mock.calls.map(([input]) => input.argv.find(arg => arg.startsWith("--origin-main-sha="))))
      .toEqual([`--origin-main-sha=${MAIN}`, `--origin-main-sha=${fresh}`]);
    const evidenceRoot = join(result.runRoot, "artifacts/github-issue-roadmap");
    expect(existsSync(join(evidenceRoot, "run-evidence.json"))).toBe(true);
    expect(existsSync(join(evidenceRoot, "repin/run-evidence-1.json"))).toBe(true);
  });

  it("re-probes a code-only pre-apply move and refuses when the completion rule now matches", async () => {
    const value = fixture(1, "`probeExport` is exported from `scripts/probe.ts`.");
    const main = movingMain(value);
    main.add(fresh, { "scripts/probe.ts": "export const probeExport = true;" });
    main.afterShadow(fresh);
    const probe = vi.spyOn(existenceProbe, "probeExistenceAtSha");
    await expect(value.execute()).rejects.toThrow(drift);
    expect(probe).toHaveBeenCalledOnce();
    if (probe.mock.results[0].type === "throw") throw probe.mock.results[0].value;
    expect(probe.mock.results[0]).toMatchObject({ type: "return" });
    expect(probe.mock.results[0].value).toMatchObject({ entries: [{ state: "demonstrated" }] });
    value.untouchedTransport();
  });

  it("refuses when delivery verification fails at the new history", async () => {
    const value = fixture();
    const main = movingMain(value);
    main.add(fresh, { "docs/note.md": "Safe merge; delivery verification independently fails." });
    main.duringAssessment(fresh);
    const next = dispositionHistory(fresh, { repoRoot: value.root, runGit: value.input.runGit });
    vi.spyOn(findingDelivery, "assertDeliveryInboxOutsideWorktrees").mockReturnValue(value.root);
    vi.spyOn(findingDelivery, "readFindingDelivery").mockReturnValue({
      commit: HEAD, envelopeBase64: Buffer.from(JSON.stringify(value.envelope)).toString("base64"),
      envelopeSha256: canonicalJsonSha256(value.envelope), sidecarLocator: "finding.roadmap-outcomes.json",
      verification: { deliverable: true },
    } as ReturnType<typeof findingDelivery.readFindingDelivery>);
    vi.spyOn(findingDelivery, "deliveryEnvelope").mockReturnValue(value.envelope);
    const verify = vi.spyOn(findingDelivery, "verifyFindingDelivery").mockImplementation((_root, _record, _git, history) => {
      if (history === next) throw new Error("Fixture delivery verification failure");
      return value.envelope;
    });
    await expect(runFileFindingCli({ ...value.input, argv: ["--delivery=fixture-delivery.json", "--repository=example-org/example-repo", "--execute"],
      operatorToken: "fixture-token" })).rejects.toThrow(drift);
    expect(verify.mock.calls.some(call => call[3] === next)).toBe(true);
    value.untouchedTransport();
  });
});

describe("per-candidate result exit contract", () => {
  const qualify = (kind: string, badProof = false) => {
    const root = mkdtempSync(join(tmpdir(), "filing-qualified-labels-")); roots.push(root);
    const base = stackEnvelope((qualification.ACTION_QUALIFICATION_BAR.minimumLabeledCases as Readonly<Record<string, number>>)[kind]);
    const qualifiedEnvelope = createOutcomeEnvelope({ ...base, candidates: base.candidates.map(({ sourceFingerprint: _s, emissionContentSha256: _e, ...candidate }) => ({ ...candidate, stableOutcomeId: `grant-${candidate.stableOutcomeId}` })) });
    const built = buildIntakeStack({ envelope: qualifiedEnvelope, match: () => "plausible_overlap" });
    const { envelope, snapshot } = built;
    const { schemaVersion: _schema, promptLocator: _locator, ...stack } = parseAssessmentStackDescriptor(JSON.parse(readFileSync(REPO_STACK_DESCRIPTOR, "utf8")), readFileSync(REPO_ASSESSMENT_PROMPT, "utf8"));
    void _schema; void _locator;
    const assessment = parseIntakeAssessment({ ...built.assessment, stack }, envelope, snapshot, undefined, new Map());
    const compilerInput = { dispositionHistory: new Map(), envelope, snapshot, assessment, existenceRecord: built.existenceRecord, verifiedOriginMainSha: built.existenceRecord.originMainSha };
    const decision = compileIntakeDecision(compilerInput);
    const operands = deriveIntakeObservationOperands({ ...compilerInput, decision });
    writeFileSync(join(root, "candidate.json"), prettyCanonicalJson(envelope));
    writeFileSync(join(root, "snapshot.json"), prettyCanonicalJson(snapshot));
    const stackHash = qualification.currentAssessmentStackHash(process.cwd());
    const records = envelope.candidates.map(candidate => {
      const observation = bankIntakeObservation({ repoRoot: root,
        candidate: { locator: "candidate.json", contentSha256: canonicalJsonSha256(envelope), sourceFingerprint: candidate.sourceFingerprint },
        snapshot: { locator: "snapshot.json", contentSha256: snapshot.contentSha256 }, decisionSha256: canonicalJsonSha256(decision),
        assessmentSha256: decision.assessmentSha256, assessmentStackSha256: decision.assessmentStackSha256, producerKind: "plan", observedMatch: decision.candidates.find(item => item.sourceFingerprint === candidate.sourceFingerprint)!.matchResult, observedAt: NOW.toISOString(),
        operands: operands.get(candidate.sourceFingerprint)!,
      }).record;
      return buildJudgementRecord({ observationId: observation.observationId, judgedMatch: observation.observedMatch, judgedBy: "human_operator", judgedAt: NOW.toISOString(), scoringVersion: INTAKE_CALIBRATION_SCORING_VERSION, split: "holdout",
        observed: { producerKind: observation.producerKind, observedMatch: observation.observedMatch, observedDisposition: observation.observedDisposition, routineEligible: null, sensitiveActionAutomatic: false, assessmentStackSha256: stackHash, observedAt: observation.observedAt },
        renderedMaterial: { materialSha256: canonicalJsonSha256(observation), rendererVersion: "fixture/v1", textCapture: "agreement_not_captured", verificationFreshness: { trustedMarkerWithinRecencyWindow: null, trustedMarkerBoundToSnapshotOriginMainSha: null } },
        extensions: { actionLabel: { repository: capabilities.repository, sourceFingerprint: candidate.sourceFingerprint, actionKind: kind, targetIssueNumber: 7, verdict: "correct" } } });
    });
    const bytes = Buffer.from(prettyCanonicalJson(records));
    const manifest = { ...capabilities, capabilities: capabilities.capabilities.map(entry => ({ ...entry, proofSha256: entry.proofSha256 as string | null })) };
    const entry = manifest.capabilities.find(entry => entry.capability === kind)!;
    if (entry !== undefined) { entry.enabled = true; entry.qualification = "production"; entry.proofSha256 = createHash("sha256").update(badProof ? "incorrect proof bytes" : bytes).digest("hex"); }
    const loader = vi.spyOn(judgeCli, "loadActionQualificationContext").mockImplementation(repoRoot => ({
      repoRoot, judgementRoot: resolveActionJudgementRoot(), manifest: parseDispatcherCapabilityManifest(manifest), committedLabelSets: { [kind]: bytes },
    }));
    return { manifest, bytes, loader };
  };

  const labelAction = (root: string, observationId: string, kind: string, verdict = "incorrect") => {
    const previous = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      return runJudgeCli({ cwd: root, argv: [`--observation-id=${observationId}`, `--action-kind=${kind}`, "--target-issue=7", `--action-verdict=${verdict}`, "--judged-by=human_operator", "--judged-at=2026-08-21T12:00:00.000Z"] });
    } finally {
      stdout.mockRestore();
      if (previous) Object.defineProperty(process.stdin, "isTTY", previous); else Reflect.deleteProperty(process.stdin, "isTTY");
    }
  };

  const overlap = (value: ReturnType<typeof fixture>) => {
    value.publishCensus(stackSnapshot(value.envelope, censusPass([censusIssue({ number: 7 })])));
    const caller = value.caller.getMockImplementation()!;
    value.caller.mockImplementation(async call => {
      const result = await caller(call); const assessment = result.output as ReturnType<typeof evidenceAssessment>;
      return { ...result, output: { ...assessment, candidates: assessment.candidates.map(candidate => ({ ...candidate, match: { ...candidate.match, result: "plausible_overlap", competingIssueNumbers: [7] } })) } };
    });
  };

  it.each([false, true])("uses the probe SHA for append authority, keeping local-only grants as suggestions (merged=%s)", async merged => {
    const authority = qualify("append_evidence_overlap");
    authority.loader.mockRestore();
    const value = fixture(); overlap(value);
    const mergedManifest = structuredClone(merged ? authority.manifest : capabilities);
    const git = value.input.runGit.getMockImplementation()!;
    value.input.runGit.mockImplementation((cwd, args) => {
      if (args[0] === "show") {
        if (args[1] === `${MAIN}:scripts/github-issue-roadmap-capabilities.json`) return Buffer.from(prettyCanonicalJson(mergedManifest)).toString("base64");
        if (args[1] === "HEAD:scripts/roadmap-intake-qualification/append_evidence_overlap.json"
          || merged && args[1] === `${MAIN}:scripts/roadmap-intake-qualification/append_evidence_overlap.json`) return authority.bytes.toString("base64");
      }
      return git(cwd, args);
    });
    value.write("scripts/github-issue-roadmap-capabilities.json", prettyCanonicalJson(authority.manifest));
    const imported = capabilities.capabilities.find(entry => entry.capability === "append_evidence_overlap")!;
    const original = { ...imported };
    try {
      Object.assign(imported, authority.manifest.capabilities.find(entry => entry.capability === "append_evidence_overlap"));
      const result = await value.execute();
      expect(result.candidates[0]).toMatchObject(merged ? { disposition: "appended", issueNumber: 7 }
        : { disposition: "filed", suggestion: { kind: "append", targetIssueNumber: 7 } });
      expect(value.transport.appendEvidenceComment).toHaveBeenCalledTimes(merged ? 1 : 0);
      expect(value.transport.createIssue).toHaveBeenCalledTimes(merged ? 0 : 1);
      expect(value.input.runGit).toHaveBeenCalledWith(value.root, ["show", `${MAIN}:scripts/github-issue-roadmap-capabilities.json`],
        { output: "base64", localObjectsOnly: true });
    } finally { Object.assign(imported, original); }
  });

  it("refuses model append on proof mismatch and names the qualification readout", async () => {
    qualify("append_evidence_overlap", true); const value = fixture(); overlap(value);
    const result = await value.execute();
    expect(result.candidates[0]).toMatchObject({ disposition: "filed", suggestion: { kind: "append", targetIssueNumber: 7 },
      actionQualification: [{ kind: "append_evidence_overlap", reason: "qualification_proof_mismatch", fixingCommand: "npm run roadmap:action-qualification" }] });
    expect(value.transport.appendEvidenceComment).not.toHaveBeenCalled();
  });

  it("labels a banked suggestion from a fresh process after the run workspace is removed", async () => {
    const value = fixture(); overlap(value);
    const result = await runFileFindingCli(value.input);
    const id = result.candidates[0].judgementObservationId!;
    const shared = actionMaterialRoot(resolveActionJudgementRoot(), id);
    expect(readFileSync(join(shared, "bindings/candidate.json"))).toEqual(readFileSync(join(result.runRoot, "artifacts/github-issue-roadmap/candidate.json")));
    // The judge must use only the retained material, not accidentally resolve run-local files.
    rmSync(result.runRoot, { recursive: true, force: true });
    const child = spawnSync(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), resolve("scripts/github-issue-roadmap-judge.ts"),
      `--observation-id=${id}`, "--action-kind=append_evidence_overlap", "--target-issue=7", "--action-verdict=incorrect", "--judged-by=agent", "--judged-at=2026-08-21T12:00:00.000Z"],
    { cwd: process.cwd(), windowsHide: true, encoding: "utf8", timeout: 15000, env: { ...process.env } });
    expect(child.stderr).toBe(""); expect(child.status).toBe(0);
    const record = readJudgementRecordRevisions(join(resolveActionJudgementRoot(), "labels"))[0].record;
    expect(record).toMatchObject({ observationId: id, split: "holdout", extensions: { actionLabel: { actionKind: "append_evidence_overlap", targetIssueNumber: 7, verdict: "incorrect" } } });
    expect(record.renderedMaterial.textCapture).toBe("disagreement_captured");
    const human = spawnSync(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), resolve("scripts/github-issue-roadmap-judge.ts"),
      `--observation-id=${id}`, "--action-kind=append_evidence_overlap", "--target-issue=7", "--action-verdict=correct", "--judged-by=human_operator", "--judged-at=2026-08-21T12:00:00.000Z"],
    { cwd: process.cwd(), windowsHide: true, encoding: "utf8", timeout: 15000, env: { ...process.env } });
    expect(human.status).toBe(1); expect(human.stderr).toContain("interactive stdin");
    expect(readJudgementRecordRevisions(join(resolveActionJudgementRoot(), "labels"))).toHaveLength(1);
    const corrected = labelAction(value.root, id, "append_evidence_overlap", "correct");
    expect(corrected.actionReadout).toMatchObject({ actionKind: "append_evidence_overlap", score: { labeledCases: 1, correctCases: 1, qualified: false } });
    expect(readJudgementRecordRevisions(join(resolveActionJudgementRoot(), "labels"))).toHaveLength(2);
  });

  it("the next filing run makes appends suggestion-only after uncommitted labels drop precision", async () => {
    qualify("append_evidence_overlap"); const value = fixture(2); overlap(value);
    const preview = await runFileFindingCli(value.input);
    expect(preview.candidates.map(item => item.disposition)).toEqual(["dry-run", "dry-run"]);
    for (const item of preview.candidates) labelAction(value.root, item.judgementObservationId!, "append_evidence_overlap");
    const result = await value.execute();
    expect(result.candidates.map(item => item.disposition)).toEqual(["filed", "filed"]);
    expect(result.candidates.every(item => item.suggestion?.kind === "append")).toBe(true);
    expect(value.transport.appendEvidenceComment).not.toHaveBeenCalled();
  });

  it("the next filing run makes close suggestion-only after one uncommitted wrong close", async () => {
    qualify("close_issue_existence"); const value = fixture(1, "`probeExport` is exported from `scripts/probe.ts`.");
    value.publishCensus(stackSnapshot(value.envelope, censusPass([censusIssue({ number: 7, body: markerBlock(value.envelope, value.envelope.candidates[0], "d".repeat(64)) })])));
    const git = value.input.runGit.getMockImplementation()!;
    value.input.runGit.mockImplementation((cwd, args) => {
      if (args[0] === "ls-tree") return "scripts/probe.ts";
      if (args[0] === "grep") return `${MAIN}:scripts/probe.ts:1:export const probeExport = true;`;
      if (args[0] === "show") return "export const probeExport = true;";
      if (args[0] === "log") return MAIN;
      if (args[0] === "merge-base") return "";
      return git(cwd, args);
    });
    const preview = await runFileFindingCli(value.input);
    expect(preview.candidates[0].disposition).toBe("dry-run");
    labelAction(value.root, preview.candidates[0].judgementObservationId!, "close_issue_existence");
    const result = await value.execute();
    expect(result.candidates[0]).toMatchObject({ disposition: "hold", suggestion: { kind: "close", targetIssueNumber: 7 } });
    value.untouchedTransport();
  });

  it.each([{ competitors: [7] }, { competitors: [7, 8] }])("qualified overlap with competitors $competitors binds only a single target", async ({ competitors }) => {
    qualify("append_evidence_overlap");
    const value = fixture();
    value.publishCensus(stackSnapshot(value.envelope,
      censusPass(competitors.map(number => censusIssue({ number })))));
    const caller = value.caller.getMockImplementation()!;
    value.caller.mockImplementation(async call => {
      const result = await caller(call);
      const assessment = result.output as ReturnType<typeof evidenceAssessment>;
      return { ...result, output: { ...assessment, candidates: assessment.candidates.map(candidate => ({
        ...candidate, match: { ...candidate.match, result: "plausible_overlap", competingIssueNumbers: competitors },
      })) } };
    });
    const result = await value.execute();
    if (competitors.length === 1) {
      expect(result.candidates[0]).toMatchObject({ disposition: "appended", issueNumber: 7, appendKind: "model_overlap" });
      expect(value.transport.createIssue).not.toHaveBeenCalled();
      expect(value.transport.appendEvidenceComment).toHaveBeenCalledOnce();
      expect(result.apply!.writes[0].actions).toEqual(["append_evidence_overlap"]);
      expect(result.appends).toEqual({ marker: [], modelJudged: [7] });
      labelAction(value.root, result.candidates[0].judgementObservationId!, "append_evidence_overlap", "correct");
      expect((await value.execute()).candidates[0]).toMatchObject({ disposition: "replay", issueNumber: 7 });
      expect(value.transport.appendEvidenceComment).toHaveBeenCalledOnce();
    } else {
      expect(result.candidates[0]).toMatchObject({ disposition: "filed", suggestions: competitors.map(targetIssueNumber => ({ kind: "append", targetIssueNumber })) });
      expect(value.transport.appendEvidenceComment).not.toHaveBeenCalled();
      expect(value.transport.createIssue).toHaveBeenCalledOnce();
    }
  });

  it.each([true, false])("qualified existence close checks transport support before writes (supported=%s)", async supported => {
    qualify("close_issue_existence");
    const value = fixture(1, "`probeExport` is exported from `scripts/probe.ts`.");
    value.publishCensus(stackSnapshot(value.envelope, censusPass([
      censusIssue({ number: 7, body: markerBlock(value.envelope, value.envelope.candidates[0], "d".repeat(64)) }),
    ])));
    const git = value.input.runGit.getMockImplementation()!;
    value.input.runGit.mockImplementation((cwd, args) => {
      if (args[0] === "ls-tree") return "scripts/probe.ts";
      if (args[0] === "grep") return `${MAIN}:scripts/probe.ts:1:export const probeExport = true;`;
      if (args[0] === "show") return "export const probeExport = true;";
      if (args[0] === "log") return MAIN;
      if (args[0] === "merge-base") return "";
      return git(cwd, args);
    });
    const mutations: { method: string; url: string; body: unknown }[] = [];
    const real = createGitHubIntakeApprovalTransport({ token: "fixture-token", fetchImpl: vi.fn(async (url, init) => {
      if (String(url) === "https://api.github.com/graphql") {
        expect(JSON.parse(init!.body as string).query).toMatch(/^query IntakeFilingViewer/);
        return Response.json({ data: { viewer: null } });
      }
      if (init?.method === "POST" || init?.method === "PATCH") {
        mutations.push({ method: init.method, url: String(url), body: JSON.parse(init.body as string) });
        return new Response(JSON.stringify(init.method === "POST" ? { id: 123 } : { number: 7, state: "closed" }));
      }
      if (String(url).includes("issue-types")) return new Response(JSON.stringify([{ name: "Task" }]));
      if (String(url).includes("issue-fields")) return new Response("[]");
      throw new Error(`Unexpected HTTP ${url}`);
    }) });
    const result = await runFileFindingCli({ ...value.input, argv: [...value.input.argv, "--execute"], operatorToken: "fixture-token",
      openTransport: () => ({ ...real, supportsCloseIssue: supported,
        preflightClassifications: value.transport.preflightClassifications,
        applyClassification: value.transport.applyClassification, verifyClassifications: value.transport.verifyClassifications }) });
    expect(result.candidates[0]).toMatchObject({ disposition: supported ? "closed" : "refused" });
    expect(result.candidates[0].issueNumber).toBe(supported ? 7 : undefined);
    expect(mutations.map(({ method, url }) => [method, url])).toEqual(supported ? [
      ["POST", "https://api.github.com/repos/example-org/example-repo/issues/7/comments"],
      ["PATCH", "https://api.github.com/repos/example-org/example-repo/issues/7"],
    ] : []);
    if (supported) {
      expect(result.apply!.writes[0].actions).toEqual(["append_evidence", "close_issue_existence"]);
      labelAction(value.root, result.candidates[0].judgementObservationId!, "close_issue_existence", "correct");
    }
    else expect(result.candidates[0].reason).toContain("close_unsupported");
  });

  it("keeps an already completed evidence append when a fresh disposition withdraws the close", async () => {
    qualify("close_issue_existence");
    const value = fixture(1, "`probeExport` is exported from `scripts/probe.ts`.");
    value.publishCensus(stackSnapshot(value.envelope, censusPass([
      censusIssue({ number: 7, body: markerBlock(value.envelope, value.envelope.candidates[0], "d".repeat(64)) }),
    ])));
    let landed = false;
    const fresh = "c".repeat(40);
    const git = value.input.runGit.getMockImplementation()!;
    value.input.runGit.mockImplementation((cwd, args) => {
      if (args[0] === "rev-parse" && (args[2] === `${fresh}^{commit}` || landed && args[2] === "origin/main^{commit}")) return fresh;
      if (args[0] === "log" && args.includes("--raw")) return landed
        ? `${fresh}\n:000000 100644 ${"0".repeat(40)} ${"b".repeat(40)} A\tartifacts/github-issue-roadmap/history.roadmap-outcomes.json\n` : "";
      if (args[0] === "cat-file" && args[2] === "b".repeat(40)) return Buffer.from(JSON.stringify(terminalEnvelope(value.envelope))).toString("base64");
      if (args[0] === "ls-tree") return "scripts/probe.ts";
      if (args[0] === "grep") return `${MAIN}:scripts/probe.ts:1:export const probeExport = true;`;
      if (args[0] === "show") return "export const probeExport = true;";
      if (args[0] === "log") return MAIN;
      if (args[0] === "merge-base") return "";
      return git(cwd, args);
    });
    value.transport.appendEvidenceComment.mockImplementation(async () => { landed = true; return { commentId: "C_retained" }; });
    const result = await runFileFindingCli({ ...value.input, argv: [...value.input.argv, "--execute"], operatorToken: "test-token",
      dispositionHistory: ref => dispositionHistory(ref, { repoRoot: value.root, runGit: value.input.runGit }),
      openTransport: () => ({ ...value.transport, supportsCloseIssue: true }) });
    expect(result.candidates[0].disposition).toBe("dispositioned");
    expect(value.transport.appendEvidenceComment).toHaveBeenCalledOnce();
    expect(value.transport.closeIssue).not.toHaveBeenCalled();
    expect(value.transport.applyClassification).not.toHaveBeenCalled();
    expect(result.apply!.ledgerRecords[0]).toMatchObject({ durableState: "withdrawn_dispositioned", actionsTaken: ["append_evidence"],
      result: { issueNumber: 7, commentId: "C_retained" } });
    const journal = readJournal(resolveJournalPath("example-org/example-repo"));
    expect(journal.records.map(record => (record as { event?: string }).event)).toEqual(["intent", "withdrawn_dispositioned"]);
    expect(intakeApply.deriveRepositoryCreateBudget(intakeApply.indexHistory(journal.records), "example-org/example-repo", NOW).count).toBe(0);
  });

  it("AE1 files three of four novel candidates when the repository has three creates left", async () => {
    const value = fixture(4);
    const path = resolveJournalPath("example-org/example-repo");
    const claim = acquireExecutionClaim(path, { mode: "execute" });
    try {
      for (let index = 0; index < intakeApply.INTAKE_CREATE_LIMITS.repositoryCreates - 3; index++) claim.withOwnership(() => appendJournal(path, {
        schemaVersion: "github-issue-roadmap-intake-approval-ledger/v1", event: "intent", appliedAt: new Date().toISOString(),
        repository: "example-org/example-repo", sourceFingerprint: `budget-seed-${index}`, action: "create_issue",
        emissionContentSha256: "a".repeat(64), decisionContentSha256: "b".repeat(64),
        payload: { issue: { title: "Budget seed", body: "Unconfirmed attempt" }, evidenceComment: null, closeIssue: null },
        classifications: [], issueNumber: null, issueId: null, commentId: null,
      }));
    } finally { claim.release(); }
    const resultPath = join(value.root, "ae1-result.json");
    allowCapture(value);
    expect(await runFileFindingCommand({ ...value.input,
      argv: [...value.input.argv, "--execute", `--result=${resultPath}`], operatorToken: "fixture-token" })).toBe(2);
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as FileFindingResult;
    expect(result.candidates.map(candidate => candidate.disposition)).toEqual(["filed", "filed", "filed", "pending"]);
    expect(result.candidates[3].reason).toContain("repository_create_budget_exhausted");
    expect(value.transport.createIssue).toHaveBeenCalledTimes(3);
    expect(value.caller).toHaveBeenCalledOnce();
  });

  const candidate = (disposition: string, index: number) => ({
    sourceFingerprint: String(index).repeat(64), stableOutcomeId: `outcome-${index}`, disposition,
    reason: "fixture", ...(["filed", "replay", "appended", "closed"].includes(disposition) ? { issueNumber: index + 1 } : {}),
    ...(disposition === "refused" ? { fixingCommand: "retry fixture" } : {}),
    ...(disposition === "hold" ? { competingIssues: [7, 8] } : {}),
    ...(disposition === "dry-run" ? { projectedAction: "create_issue" } : {}),
  });
  it.each([
    ["completed", ["filed"], 0], ["completed", ["replay"], 0],
    ["completed", ["appended", "closed"], 0], ["no-op", [], 0], ["dry-run", ["dry-run", "replay"], 0],
    ["dry-run", ["dry-run", "hold"], 1], ["dry-run", ["dry-run", "refused"], 1],
    ["completed", ["filed", "pending"], 2], ["completed", ["hold", "filed"], 1],
    ["completed", ["hold", "pending"], 1], ["completed", ["refused", "pending"], 1],
    ["infrastructure", ["filed", "interrupted"], 4],
    ["infrastructure", ["refused"], 4], ["completed", ["interrupted", "hold"], 4],
    ["busy", [], 5], ["busy", ["interrupted", "refused", "pending"], 5],
  ])("derives %s / %j => %i", (status, dispositions, expected) => {
    const result = { schemaVersion: 1, status, runRoot: "fixture-run",
      requestedAssessor: { provider: "fixture", model: "requested-model", prompt: "prompt-v1", release: "release-v1" },
      candidates: (dispositions as string[]).map(candidate),
    } as FileFindingResult;
    expect(fileFindingExitCode(result)).toBe(expected);
  });

  it("does not let a suggestion change a filed candidate's exit", () => {
    expect(fileFindingExitCode({ schemaVersion: 1, status: "completed", runRoot: "fixture-run",
      requestedAssessor: { provider: "fixture", model: "requested-model", prompt: "prompt-v1", release: "release-v1" },
      candidates: [{ ...candidate("filed", 1), suggestion: { kind: "append", targetIssueNumber: 7 } }],
    } as FileFindingResult)).toBe(0);
  });
});

describe("pre-apply census freshness decision", () => {
  it("uses the oldest novelty receipt and the strict one-hour bound, ignoring generatedAt and classification age", () => {
    const census = stackSnapshot(stackEnvelope(), censusPass());
    const snapshot = { ...census, generatedAt: "2026-08-20T13:00:00.000Z", receipts: census.receipts.map(receipt => ({
      ...receipt, fetchedAt: receipt.domain === "comments" ? "2026-08-20T12:00:00.000Z"
        : receipt.domain === "issues" ? "2026-08-20T12:30:00.000Z" : "2026-08-19T12:00:00.000Z",
    })) };
    expect(censusNeedsRefreshBeforeApply(snapshot, new Date("2026-08-20T12:59:59.999Z"))).toBe(false);
    expect(censusNeedsRefreshBeforeApply(snapshot, new Date("2026-08-20T13:00:00.000Z"))).toBe(false);
    expect(censusNeedsRefreshBeforeApply(snapshot, new Date("2026-08-20T13:00:00.001Z"))).toBe(true);
  });
});

describe("one committed finding to one issue", () => {
  it("reuses a census captured in worktree A from worktree B under the same journal root", async () => {
    const first = fixture();
    unlinkSync(first.censusPath);
    const runners = captureRunners(first);
    const captured = await runFileFindingCli({ ...first.input, ...runners,
      argv: first.input.argv.filter(arg => !arg.startsWith("--census=")) });
    expect(captured.metrics?.censusMode).toBe("capture");
    const second = fixture();
    unlinkSync(second.censusPath);
    vi.stubEnv("ROADMAP_INTAKE_JOURNAL_ROOT", join(first.root, "journal"));
    const reused = await runFileFindingCli({ ...second.input,
      argv: second.input.argv.filter(arg => !arg.startsWith("--census=")) });
    expect(reused.metrics?.censusMode).toBe("reuse");
    expect(reused.candidates[0].disposition).toBe("dry-run");
    expect(second.input.runPreflightCli).not.toHaveBeenCalled();
    expect(second.input.runIntakePreflightCli).not.toHaveBeenCalled();
  });

  it.each([false, true])("neither reads nor writes the legacy worktree cache (exists=%s)", async exists => {
    const value = fixture();
    unlinkSync(value.censusPath);
    const legacy = `${FILE_FINDING_ROOT}/census/intake-snapshot.json`;
    const bytes = JSON.stringify(value.census);
    if (exists) value.write(legacy, bytes);
    const runners = captureRunners(value);
    const result = await runFileFindingCli({ ...value.input, ...runners });
    expect(result.metrics?.censusMode).toBe("capture");
    expect(runners.runPreflightCli).toHaveBeenCalledOnce();
    expect(runners.runIntakePreflightCli).toHaveBeenCalledOnce();
    expect(existsSync(join(value.root, legacy))).toBe(exists);
    if (exists) expect(readFileSync(join(value.root, legacy), "utf8")).toBe(bytes);
  });

  it("reuses a fresh shared census without calling either runner", async () => {
    const value = fixture();
    const before = readFileSync(value.censusPath, "utf8");
    let clock = NOW.getTime();
    const caller = value.caller.getMockImplementation()!;
    value.caller.mockImplementation(async call => { clock += 25; return caller(call); });
    const probe = existenceProbe.runExistenceProbeCli;
    vi.spyOn(existenceProbe, "runExistenceProbeCli").mockImplementation((...args) => { clock += 5; return probe(...args); });
    const apply = intakeApply.runIntakeApplyCli;
    vi.spyOn(intakeApply, "runIntakeApplyCli").mockImplementation(async input => { clock += 10; return apply(input); });
    vi.spyOn(process, "chdir").mockImplementation(() => {});
    const result = await runFileFindingCli({ ...value.input, now: () => new Date(clock),
      argv: value.input.argv.filter(arg => !arg.startsWith("--census=")) });
    expect(result.candidates[0].disposition).toBe("dry-run");
    expect(value.input.runPreflightCli).not.toHaveBeenCalled();
    expect(value.input.runIntakePreflightCli).not.toHaveBeenCalled();
    expect(readFileSync(value.censusPath, "utf8")).toBe(before);
    expect(result.metrics).toEqual({
      censusMode: "reuse", githubReads: { canonical: 0, intake: 0, boardCheck: 2 },
      durationsMs: { claimWait: 0, census: 0, assessment: 25, existenceProbe: 5, apply: 10 },
    });
    expect(JSON.parse(readFileSync(join(result.runRoot, "result.json"), "utf8")).metrics).toEqual(result.metrics);
  });

  it("refreshes a stale shared census and the next invocation reuses it without capture", async () => {
    const value = fixture();
    const now = () => new Date("2026-08-20T13:00:01.000Z");
    const runners = captureRunners(value, now);
    const oldCache = readFileSync(value.censusPath, "utf8");
    const publish = sharedCensusStore.publishSharedCensus;
    let cachePublications = 0;
    vi.spyOn(sharedCensusStore, "publishSharedCensus").mockImplementation((repository, claim, bundle) => {
      cachePublications++;
      expect(readFileSync(assertSharedCensusPath(repository, claim), "utf8")).toBe(oldCache);
      expect(() => acquireExecutionClaim(resolveJournalPath(repository), { mode: "execute" })).toThrow();
      publish(repository, claim, bundle);
    });
    const input = { ...value.input, ...runners, now, argv: value.input.argv.filter(arg => !arg.startsWith("--census=")) };
    const first = await runFileFindingCli(input);
    expect(first.candidates[0].disposition).toBe("dry-run");
    expect(runners.runPreflightCli).toHaveBeenCalledOnce();
    expect(runners.runIntakePreflightCli).toHaveBeenCalledOnce();
    const capturedPath = runners.runIntakePreflightCli.mock.results[0].value;
    const capturedBytes = readFileSync(capturedPath, "utf8");
    expect(relative(first.runRoot, capturedPath)).not.toMatch(/^\.\./);
    expect(JSON.parse(readFileSync(value.censusPath, "utf8")).intakeSnapshot).toEqual(JSON.parse(capturedBytes));
    expect(readdirSync(dirname(value.censusPath))).toEqual(["bundle.json"]);
    runners.runPreflightCli.mockClear();
    runners.runIntakePreflightCli.mockClear();
    const { sourceFingerprint: _fingerprint, emissionContentSha256: _emission, ...material } = value.envelope.candidates[0];
    void _fingerprint; void _emission;
    const nextEnvelope = createOutcomeEnvelope({ ...value.envelope, candidates: [{ ...material, stableOutcomeId: "next-cached-finding" }] });
    writeFileSync(value.candidatePath, JSON.stringify(nextEnvelope));
    const second = await runFileFindingCli(input);
    expect(second.candidates[0].disposition).toBe("dry-run");
    expect(runners.runPreflightCli).not.toHaveBeenCalled();
    expect(runners.runIntakePreflightCli).not.toHaveBeenCalled();
    const snapshot = value.caller.mock.calls[1][0].evidence.intakeSnapshot as IntakeSnapshotV1;
    expect(snapshot.candidateSha256).toBe(canonicalJsonSha256(nextEnvelope));
    expect(readFileSync(capturedPath, "utf8")).toBe(capturedBytes);
    expect(JSON.parse(readFileSync(value.censusPath, "utf8")).intakeSnapshot).toEqual(JSON.parse(capturedBytes));
    value.untouchedTransport();
    expect(cachePublications).toBe(1);
  });

  it.each(["malformed", "repository-mismatched"])("captures instead of reusing a %s shared census", async kind => {
    const value = fixture();
    const changed = { ...value.census, repository: { ...value.census.repository, databaseId: 999 } };
    const { candidateSha256, canonicalSnapshotV2Sha256, repository, censusContentSha256, issues, markerIndex, markerIncidents, projectObservation, receipts } = changed;
    changed.contentSha256 = canonicalJsonSha256({ candidateSha256, canonicalSnapshotV2Sha256, repository, censusContentSha256, issues, markerIndex, markerIncidents, projectObservation, receipts });
    if (kind === "malformed") writeFileSync(value.censusPath, "{}");
    else value.publishCensus(parseIntakeSnapshotV1(changed));
    const runners = captureRunners(value);
    const result = await runFileFindingCli({ ...value.input, ...runners,
      argv: value.input.argv.filter(arg => !arg.startsWith("--census=")) });
    expect(result.candidates[0].disposition).toBe("dry-run");
    expect(runners.runPreflightCli).toHaveBeenCalledOnce();
    expect(runners.runIntakePreflightCli).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(value.censusPath, "utf8")).repository).toEqual(value.envelope.repository);
  });

  it("uses an explicit fresh census instead of the shared slot", async () => {
    const value = fixture();
    const supplied = value.write("supplied-census.json", readFileSync(value.censusPath, "utf8"));
    const marker = markerBlock(value.envelope, value.envelope.candidates[0]);
    value.publishCensus(stackSnapshot(value.envelope, censusPass([censusIssue({ body: marker })])));
    const shared = readFileSync(value.censusPath, "utf8");
    const result = await runFileFindingCli({ ...value.input,
      argv: [...value.input.argv.filter(arg => !arg.startsWith("--census=")), `--census=${supplied}`] });
    expect(result.candidates[0].disposition).toBe("dry-run");
    expect(value.input.runPreflightCli).not.toHaveBeenCalled();
    expect(value.input.runIntakePreflightCli).not.toHaveBeenCalled();
    expect(readFileSync(value.censusPath, "utf8")).toBe(shared);
  });

  it("without --census or a shared cache invokes both runners once and writes under its run root", async () => {
    const value = fixture();
    unlinkSync(value.censusPath);
    let clock = NOW.getTime();
    const canonicalReads = vi.fn<readOnlyReader.GhRunner>(() => "{}");
    const intakeReads = vi.fn<readOnlyReader.GhRunner>(() => "{}");
    vi.spyOn(preflight, "createGhRunner").mockReturnValue(canonicalReads);
    vi.spyOn(readOnlyReader, "createReadOnlyGhRunner").mockReturnValue(intakeReads);
    const runPreflightCli = vi.fn<typeof canonicalPreflight>((argv, runGh) => {
      expect(argv).toContain("--snapshot-version=v2");
      for (let read = 0; read < 2; read++) runGh?.(["api", "/fixture/canonical"]);
      clock += 10;
      const out = argv.find(arg => arg.startsWith("--out="))!.slice(6);
      writeFileSync(out, JSON.stringify(value.canonicalSnapshot), { flag: "wx" });
      writeFileSync(argv.find(arg => arg.startsWith("--fingerprint-out="))!.slice("--fingerprint-out=".length),
        JSON.stringify(censusBundle(value.census, NOW).boardFingerprint), { flag: "wx" });
    });
    const runIntakePreflightCli = vi.fn<typeof intakePreflight>((argv, _repoRoot, runGh) => {
      for (let read = 0; read < 3; read++) runGh?.(["api", "/fixture/intake"]);
      clock += 20;
      const out = argv.find(arg => arg.startsWith("--out="))!.slice(6);
      writeFileSync(out, JSON.stringify(value.census), { flag: "wx" });
      const pass = censusPass();
      writeFileSync(argv.find(arg => arg.startsWith("--census-pass-out="))!.slice("--census-pass-out=".length),
        JSON.stringify({ pass, bookend: { completedAt: value.census.census.bookendCompletedAt,
          excludedPullRequestCount: pass.excludedPullRequestCount, receipts: [],
          updatedAt: Object.fromEntries(pass.issues.map(issue => [issue.number, issue.updatedAt])) } }), { flag: "wx" });
      return out;
    });
    // Vitest workers cannot change the process-global cwd.
    vi.spyOn(process, "chdir").mockImplementation(() => {});
    const input = { ...value.input, now: () => new Date(clock),
      argv: value.input.argv.filter(arg => !arg.startsWith("--census=")), runPreflightCli, runIntakePreflightCli };
    const result = await runFileFindingCli(input);
    expect(result.candidates[0].disposition).toBe("dry-run");
    expect(runPreflightCli).toHaveBeenCalledOnce();
    expect(runIntakePreflightCli).toHaveBeenCalledOnce();
    const capturePath = runIntakePreflightCli.mock.results[0].value;
    expect(relative(result.runRoot, capturePath)).not.toMatch(/^\.\./);
    expect(JSON.parse(readFileSync(capturePath, "utf8")).candidateSha256).toBe(canonicalJsonSha256(value.envelope));
    expect(JSON.parse(readFileSync(value.censusPath, "utf8")).intakeSnapshot).toEqual(JSON.parse(readFileSync(capturePath, "utf8")));
    expect(result.metrics).toEqual({
      censusMode: "capture", githubReads: { canonical: 2, intake: 3 },
      durationsMs: { claimWait: 0, census: 30, assessment: 0, existenceProbe: 0, apply: 0 },
    });
    expect(canonicalReads).toHaveBeenCalledTimes(2);
    expect(intakeReads).toHaveBeenCalledTimes(3);
    expect(result.metrics?.githubReads).toEqual({ canonical: canonicalReads.mock.calls.length, intake: intakeReads.mock.calls.length });
    expect(JSON.parse(readFileSync(join(result.runRoot, "result.json"), "utf8")).metrics).toEqual(result.metrics);
    value.untouchedTransport();
  });

  it("publishes reached-stage metrics when census capture is refused", async () => {
    const value = fixture();
    unlinkSync(value.censusPath);
    let clock = NOW.getTime();
    const canonicalReads = vi.fn<readOnlyReader.GhRunner>(() => "{}");
    vi.spyOn(preflight, "createGhRunner").mockReturnValue(canonicalReads);
    vi.spyOn(process, "chdir").mockImplementation(() => {});
    const runPreflightCli = vi.fn<typeof canonicalPreflight>((_argv, runGh) => {
      runGh?.(["api", "/fixture/canonical"]);
      clock += 12;
      throw new Error("fixture capture refused");
    });
    const resultPath = join(value.root, "refused-result.json");
    const exit = await runFileFindingCommand({ ...value.input, now: () => new Date(clock), runPreflightCli,
      argv: [...value.input.argv.filter(arg => !arg.startsWith("--census=")), `--result=${resultPath}`] });
    expect(exit).toBe(1);
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as FileFindingResult;
    expect(result.candidates[0]).toMatchObject({ disposition: "refused", reason: "census_unavailable: fixture capture refused" });
    expect(result.metrics).toEqual({
      censusMode: "capture", githubReads: { canonical: 1, intake: 0 }, durationsMs: { claimWait: 0, census: 12 },
    });
    expect(canonicalReads).toHaveBeenCalledOnce();
    expect(value.input.runIntakePreflightCli).not.toHaveBeenCalled();
    expect(value.caller).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(result.runRoot, "result.json"), "utf8")).metrics).toEqual(result.metrics);
    value.untouchedTransport();
  });

  it("files without a supplied census, captures under the held claim, and restores cwd", async () => {
    const value = fixture();
    unlinkSync(value.censusPath);
    const runners = captureRunners(value);
    const result = await runFileFindingCli({ ...value.input, ...runners,
      argv: [...value.input.argv.filter(arg => !arg.startsWith("--census=")), "--execute"], operatorToken: "fixture-token" });
    expect(result.candidates[0].disposition).toBe("filed");
    expect(runners.runPreflightCli).toHaveBeenCalledOnce();
    expect(runners.runIntakePreflightCli).toHaveBeenCalledOnce();
    expect(value.caller).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(value.censusPath, "utf8")).intakeSnapshot).toEqual(JSON.parse(readFileSync(runners.runIntakePreflightCli.mock.results[0].value, "utf8")));
    expect(process.cwd()).toBe(runners.callerCwd);
    expect(runners.chdir.mock.calls).toEqual([[value.root], [runners.callerCwd]]);
    const evidenceRoot = join(result.runRoot, "artifacts/github-issue-roadmap");
    expect(verifyRunEvidence({ evidenceBytes: readFileSync(join(evidenceRoot, "run-evidence.json")),
      plan: JSON.parse(readFileSync(join(evidenceRoot, "approval-plan.json"), "utf8")), repository: "example-org/example-repo",
      files: name => readFileSync(join(evidenceRoot, name)),
    }).ok).toBe(true);
  });

  it.each(["canonical", "canonical-index", "canonical-hydration", "intake"])("retries one %s census race in a new write-once directory", async stage => {
    const value = fixture();
    unlinkSync(value.censusPath);
    const runners = captureRunners(value);
    const runner = stage.startsWith("canonical") ? runners.runPreflightCli : runners.runIntakePreflightCli;
    runner.mockImplementationOnce(argv => {
      writeFileSync(runners.outputPath(argv), "partial capture", { flag: "wx" });
      throw new Error(stage === "canonical-index" ? "GitHub issues changed during preflight capture; refusing to write a mixed-version snapshot."
        : stage === "canonical-hydration" ? "GitHub issue hydration changed during canonical v2 capture; refusing a mixed-version snapshot."
        : stage === "canonical" ? "GitHub Project census changed during canonical v2 capture"
        : "Pull-request exclusion count changed during collection; refusing mixed-version intake evidence.");
    });
    const result = await runFileFindingCli({ ...value.input, ...runners,
      argv: value.input.argv.filter(arg => !arg.startsWith("--census=")) });
    expect(result.candidates[0].disposition).toBe("dry-run");
    expect(runners.runPreflightCli).toHaveBeenCalledTimes(2);
    expect(runners.runIntakePreflightCli).toHaveBeenCalledTimes(stage.startsWith("canonical") ? 1 : 2);
    const failedPath = runners.outputPath(runner.mock.calls[0][0]);
    const nextPath = runners.outputPath(runner.mock.calls[1][0]);
    expect(dirname(failedPath)).not.toBe(dirname(nextPath));
    expect(readFileSync(failedPath, "utf8")).toBe("partial capture");
    expect(value.caller).toHaveBeenCalledOnce();
    expect(process.cwd()).toBe(runners.callerCwd);
  });

  it("refuses two census races with the filing rerun as the fixing command", async () => {
    const value = fixture();
    unlinkSync(value.censusPath);
    const runners = captureRunners(value);
    runners.runIntakePreflightCli.mockImplementation(() => {
      throw new Error("GitHub issue census changed during collection; refusing mixed-version intake evidence.");
    });
    const resultPath = join(value.root, "race-result.json");
    const code = await runFileFindingCommand({ ...value.input, ...runners,
      argv: [...value.input.argv.filter(arg => !arg.startsWith("--census=")), `--result=${resultPath}`] });
    expect(code).toBe(1);
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    expect(result.candidates[0]).toMatchObject({ disposition: "refused", reason: expect.stringContaining("census_race:"),
      fixingCommand: expect.stringContaining("run-github-issue-roadmap-file-finding.ps1") });
    expect(result.candidates[0].fixingCommand).not.toContain("preflight");
    expect(runners.runPreflightCli).toHaveBeenCalledTimes(2);
    expect(runners.runIntakePreflightCli).toHaveBeenCalledTimes(2);
    expect(value.caller).not.toHaveBeenCalled();
    expect(process.cwd()).toBe(runners.callerCwd);
    expect(existsSync(join(dirname(resolveJournalPath("example-org/example-repo")), "execution.lock"))).toBe(false);
    value.untouchedTransport();
  });

  it.each([true, false])("routes the read token or stored login without ambient mutation credentials (read token=%s)", async readToken => {
    const value = fixture();
    unlinkSync(value.censusPath);
    const runners = captureRunners(value);
    vi.stubEnv("GH_TOKEN", "ambient-gh");
    vi.stubEnv("GITHUB_TOKEN", "ambient-github");
    vi.stubEnv("GH_ENTERPRISE_TOKEN", "ambient-enterprise");
    vi.stubEnv("GH_READ_ONLY_TOKEN", readToken ? "fixture-read-token" : "");
    const execute = vi.fn<readOnlyReader.GhExecutor>(() => "{}");
    const createReader = readOnlyReader.createReadOnlyGhRunner;
    vi.spyOn(readOnlyReader, "createReadOnlyGhRunner").mockImplementation(options => createReader({ ...options, execute }));
    const canonical = runners.runPreflightCli.getMockImplementation()!;
    runners.runPreflightCli.mockImplementation(argv => {
      expect(process.env.GH_TOKEN).toBe(readToken ? "fixture-read-token" : undefined);
      expect(process.env.GITHUB_TOKEN).toBeUndefined();
      expect(process.env.GH_ENTERPRISE_TOKEN).toBeUndefined();
      canonical(argv);
    });
    const intake = runners.runIntakePreflightCli.getMockImplementation()!;
    runners.runIntakePreflightCli.mockImplementation((...args) => {
      args[2]!(["api", "repos/example-org/example-repo"]);
      return intake(...args);
    });
    await runFileFindingCli({ ...value.input, ...runners, argv: value.input.argv.filter(arg => !arg.startsWith("--census=")) });
    const env = execute.mock.calls[0][2]!.env!;
    expect(env.GH_TOKEN).toBe(readToken ? "fixture-read-token" : undefined);
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(process.env.GH_TOKEN).toBe("ambient-gh");
    expect(process.env.GITHUB_TOKEN).toBe("ambient-github");
    expect(process.env.GH_ENTERPRISE_TOKEN).toBe("ambient-enterprise");
  });

  it("passes the sole read-only token to both census passes without stored login", async () => {
    const value = fixture();
    unlinkSync(value.censusPath);
    const runners = captureRunners(value);
    for (const name of readOnlyReader.AMBIENT_GITHUB_CREDENTIAL_NAMES) vi.stubEnv(name, undefined);
    vi.stubEnv("GH_READ_ONLY_TOKEN", "fixture-read-only-token");
    vi.stubEnv("GH_CONFIG_DIR", join(value.root, "no-stored-login"));
    const execute = vi.fn<readOnlyReader.GhExecutor>(() => "{}");
    const createReader = readOnlyReader.createReadOnlyGhRunner;
    vi.spyOn(readOnlyReader, "createReadOnlyGhRunner").mockImplementation(options => createReader({ ...options, execute }));
    const canonical = runners.runPreflightCli.getMockImplementation()!;
    runners.runPreflightCli.mockImplementation(argv => {
      expect(process.env.GH_TOKEN).toBe("fixture-read-only-token");
      expect(process.env.GH_CONFIG_DIR).toBe(join(value.root, "no-stored-login"));
      canonical(argv);
    });
    const intake = runners.runIntakePreflightCli.getMockImplementation()!;
    runners.runIntakePreflightCli.mockImplementation((...args) => {
      args[2]!(["api", "repos/example-org/example-repo"]);
      return intake(...args);
    });
    await runFileFindingCli({ ...value.input, ...runners, argv: value.input.argv.filter(arg => !arg.startsWith("--census=")) });
    expect(runners.runPreflightCli).toHaveBeenCalledOnce();
    expect(runners.runIntakePreflightCli).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0][2]!.env).toMatchObject({ GH_TOKEN: "fixture-read-only-token",
      GH_CONFIG_DIR: join(value.root, "no-stored-login") });
    for (const name of readOnlyReader.AMBIENT_GITHUB_CREDENTIAL_NAMES) expect(process.env[name]).toBeUndefined();
    expect(process.env.GH_READ_ONLY_TOKEN).toBe("fixture-read-only-token");
    value.untouchedTransport();
  });

  it("refuses a candidate omitted from the approval plan with its identity intact", async () => {
    const value = fixture(2);
    const buildPlan = intakeApprove.buildIntakeApprovalPlan;
    vi.spyOn(intakeApprove, "buildIntakeApprovalPlan").mockImplementation(input => {
      const plan = buildPlan(input);
      return { ...plan, entries: plan.entries.filter(entry => entry.sourceFingerprint !== value.envelope.candidates[1].sourceFingerprint) };
    });
    const result = await runFileFindingCli(value.input);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({ disposition: "dry-run", projectedAction: "create_issue" });
    expect(result.candidates[1]).toMatchObject({ disposition: "refused",
      sourceFingerprint: value.envelope.candidates[1].sourceFingerprint,
      stableOutcomeId: value.envelope.candidates[1].stableOutcomeId,
      reason: expect.stringContaining(`missing_plan_entry: ${value.envelope.candidates[1].sourceFingerprint}`),
      fixingCommand: expect.any(String) });
    expect(fileFindingExitCode(result)).toBe(1);
    value.untouchedTransport();
  });

  it.each(["canonical", "intake"])("refuses unavailable %s read credentials, restores environment/cwd, and names the fix", async stage => {
    const value = fixture();
    unlinkSync(value.censusPath);
    const runners = captureRunners(value);
    vi.stubEnv("GH_READ_ONLY_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "ambient-mutation-token");
    const runner = stage === "canonical" ? runners.runPreflightCli : runners.runIntakePreflightCli;
    runner.mockImplementation(() => { throw Object.assign(new Error("Command failed: gh api"),
      { stderr: "To get started with GitHub CLI, please run: gh auth login" }); });
    const resultPath = join(value.root, "read-credential-result.json");
    expect(await runFileFindingCommand({ ...value.input, ...runners,
      argv: [...value.input.argv.filter(arg => !arg.startsWith("--census=")), `--result=${resultPath}`] })).toBe(1);
    expect(JSON.parse(readFileSync(resultPath, "utf8")).candidates[0]).toMatchObject({ disposition: "refused",
      reason: expect.stringContaining("census_credentials_unavailable:"), fixingCommand: expect.stringContaining("GH_READ_ONLY_TOKEN") });
    expect(runner).toHaveBeenCalledOnce();
    expect(value.caller).not.toHaveBeenCalled();
    expect(process.cwd()).toBe(runners.callerCwd);
    expect(process.env.GH_TOKEN).toBe("ambient-mutation-token");
    expect(existsSync(join(dirname(resolveJournalPath("example-org/example-repo")), "execution.lock"))).toBe(false);
    value.untouchedTransport();
  });

  it("reports each dry-run candidate with its projected action and the requested stack", async () => {
    const value = fixture();
    const result = await runFileFindingCli(value.input);
    const descriptor = JSON.parse(readFileSync(join(value.root, REPO_STACK_DESCRIPTOR), "utf8"));
    expect(result).toMatchObject({ schemaVersion: 1, status: "dry-run",
      requestedAssessor: { provider: descriptor.provider, model: descriptor.model,
        prompt: descriptor.promptSha256, release: descriptor.calibrationRelease },
      candidates: [{ sourceFingerprint: value.envelope.candidates[0].sourceFingerprint,
        stableOutcomeId: value.envelope.candidates[0].stableOutcomeId, disposition: "dry-run", projectedAction: "create_issue" }],
    });
    expect(result.candidates[0]).not.toHaveProperty("issueNumber");
  });

  it("writes an interrupted result naming an unavailable assessor", async () => {
    const value = fixture();
    value.caller.mockRejectedValue(new Error("spawn codex.cmd ENOENT"));
    const resultPath = join(value.root, "failed-result.json");
    const code = await runFileFindingCommand({ ...value.input, argv: [...value.input.argv, `--result=${resultPath}`] });
    expect(code).toBe(4);
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toMatchObject({ status: "infrastructure",
      candidates: [{ disposition: "interrupted", reason: expect.stringContaining("codex.cmd"), fixingCommand: expect.stringContaining("codex") }],
    });
    value.untouchedTransport();
  });

  it("preserves the cap error code and cause through the evaluator catch", async () => {
    const value = fixture();
    const capError = new AssessmentEvidenceViewCapError(900_001, 900_000);
    const evaluate = vi.spyOn(assessmentEvaluator, "evaluateIntakeAssessmentBundle").mockRejectedValue(capError);
    const error = await value.execute().catch(error => error);
    expect(evaluate).toHaveBeenCalledOnce();
    expect(error.cause.message).toBe(`assessor_unavailable: ${capError.message}`);
    expect(error.cause.message).toContain("assessor_unavailable: view_cap_exceeded:");
    expect(error.cause.cause).toBe(capError);
    value.untouchedTransport();
  });

  it("reports an unreadable credential at transport open as infrastructure", async () => {
    const value = fixture();
    value.openTransport.mockImplementation(() => { throw new Error("credential_unreadable: fixture credential store"); });
    const path = join(value.root, "credential-result.json");
    expect(await runFileFindingCommand({ ...value.input, argv: [...value.input.argv, "--execute", `--result=${path}`], operatorToken: "fixture-token" })).toBe(4);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ status: "infrastructure",
      candidates: [{ disposition: "interrupted", reason: expect.stringContaining("credential_unreadable"), fixingCommand: expect.stringContaining("-CredentialPath") }],
    });
    expect(value.transport.createIssue).not.toHaveBeenCalled();
  });

  it("reports credential infrastructure failures returned by apply as interrupted", async () => {
    const value = fixture();
    value.transport.verifyClassifications.mockRejectedValue(new Error("credential_unreadable: classification credential"));
    const path = join(value.root, "apply-failure-result.json");
    const code = await runFileFindingCommand({ ...value.input, argv: [...value.input.argv, "--execute", `--result=${path}`], operatorToken: "fixture-token" });
    expect(code).toBe(4);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ status: "infrastructure", candidates: [{ disposition: "interrupted", reason: expect.stringContaining("credential_unreadable") }] });
  });

  it("refuses an undiagnosable lock with a manual removal step before census or assessment", async () => {
    const value = fixture();
    mkdirSync(join(dirname(resolveJournalPath("example-org/example-repo")), "execution.lock"), { recursive: true });
    const path = join(value.root, "busy-result.json");
    unlinkSync(value.censusPath);
    expect(await runFileFindingCommand({ ...value.input, argv: [...value.input.argv, "--execute", `--result=${path}`], operatorToken: "fixture-token" })).toBe(1);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ status: "completed", candidates: [{ disposition: "refused",
      fixingCommand: expect.stringContaining("manually remove the claim directory: Remove-Item -LiteralPath") }] });
    expect(value.caller).not.toHaveBeenCalled();
    value.untouchedTransport();
  });

  it.each(["-1", "1.5", "NaN", "9007199254740992"])("rejects a non-integer wait bound: %s", async waitMinutes => {
    const value = fixture();
    const acquire = vi.spyOn(executionJournal, "acquireExecutionClaim");
    await expect(runFileFindingCli({ ...value.input, argv: [...value.input.argv, `--wait-minutes=${waitMinutes}`] }))
      .rejects.toThrow("--wait-minutes must be a non-negative integer.");
    expect(acquire).not.toHaveBeenCalled();
    expect(value.caller).not.toHaveBeenCalled();
    value.untouchedTransport();
  });

  it("waits for a live claim to release after two polls, then completes with separate wait metrics", async () => {
    const value = fixture();
    const claim = acquireExecutionClaim(resolveJournalPath("example-org/example-repo"), { mode: "preflight" });
    const ownerPath = join(dirname(resolveJournalPath("example-org/example-repo")), "execution.lock", "owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    writeFileSync(ownerPath, JSON.stringify({ ...owner, acquiredAt: new Date(NOW.getTime() - 120_000).toISOString() }));
    let clock = NOW.getTime();
    let held = true;
    const sleep = vi.fn(async (milliseconds: number) => {
      expect(value.caller).not.toHaveBeenCalled();
      value.untouchedTransport();
      clock += milliseconds;
      if (sleep.mock.calls.length === 2) { claim.release(); held = false; }
    });
    try {
      const result = await runFileFindingCli({ ...value.input, sleep, now: () => new Date(clock),
        argv: [...value.input.argv, "--execute"], operatorToken: "fixture-token" });
      expect(result).toMatchObject({ status: "completed", candidates: [{ disposition: "filed", issueNumber: 1901 }],
        metrics: { durationsMs: { claimWait: 15_000, census: 0, assessment: 0, existenceProbe: 0, apply: 0 } } });
      expect(sleep.mock.calls).toEqual([[5_000], [10_000]]);
      expect(value.log.mock.calls.filter(([line]) => line.startsWith("Waiting for live intake claim")))
        .toEqual([[expect.stringContaining("mode=preflight, age=120s")], [expect.stringContaining("mode=preflight, age=125s")]]);
      expect(JSON.parse(readFileSync(join(result.runRoot, "result.json"), "utf8")).metrics).toEqual(result.metrics);
      expect(value.transport.createIssue).toHaveBeenCalledTimes(1);
    } finally { if (held) claim.release(); }
  });

  it.each([undefined, 1])("returns busy at the live-claim wait bound (wait minutes=%s)", async waitMinutes => {
    const value = fixture();
    const claim = acquireExecutionClaim(resolveJournalPath("example-org/example-repo"), { mode: "execute" });
    const path = join(value.root, "busy-result.json");
    let clock = NOW.getTime();
    const sleep = vi.fn(async (milliseconds: number) => { clock += milliseconds; });
    const acquire = vi.spyOn(executionJournal, "acquireExecutionClaim");
    try {
      expect(await runFileFindingCommand({ ...value.input, sleep, now: () => new Date(clock),
        argv: [...value.input.argv, "--execute", `--result=${path}`, ...(waitMinutes === undefined ? [] : [`--wait-minutes=${waitMinutes}`])],
        operatorToken: "fixture-token" })).toBe(5);
      const duration = (waitMinutes ?? 45) * 60_000;
      expect(clock - NOW.getTime()).toBe(duration);
      expect(sleep.mock.calls.reduce((total, [milliseconds]) => total + milliseconds, 0)).toBe(duration);
      expect(sleep.mock.calls.every(([milliseconds]) => milliseconds > 0 && milliseconds <= 60_000)).toBe(true);
      if (waitMinutes === 1) expect(sleep.mock.calls).toEqual([[5_000], [10_000], [20_000], [25_000]]);
      expect(acquire).toHaveBeenCalledTimes(sleep.mock.calls.length + 1);
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ status: "busy", metrics: { durationsMs: { claimWait: duration } },
        candidates: [{ disposition: "interrupted", fixingCommand: "Wait for the live intake run to finish, then rerun the filing command." }] });
      expect(claim.withOwnership(() => true)).toBe(true);
      expect(value.input.runPreflightCli).not.toHaveBeenCalled();
      expect(value.caller).not.toHaveBeenCalled();
      value.untouchedTransport();
    } finally { claim.release(); }
  });

  it.each(["unverifiable_holder", "undiagnosable"] as const)("does not wait for a %s refusal", async reason => {
    const value = fixture();
    const lockPath = join(dirname(resolveJournalPath("example-org/example-repo")), "execution.lock");
    if (reason === "unverifiable_holder") {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ token: "a".repeat(32), pid: process.pid,
        hostname: "other-host", bootEpochMs: 0, acquiredAt: NOW.toISOString(), mode: "execute" }));
    } else mkdirSync(lockPath);
    const sleep = vi.fn(async (_milliseconds: number) => {});
    const acquire = vi.spyOn(executionJournal, "acquireExecutionClaim");
    const path = join(value.root, "refusal-result.json");
    expect(await runFileFindingCommand({ ...value.input, sleep,
      argv: [...value.input.argv, "--execute", `--result=${path}`], operatorToken: "fixture-token" })).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ status: "completed", metrics: { durationsMs: { claimWait: 0 } },
      candidates: [{ disposition: "refused", fixingCommand: reason === "unverifiable_holder"
        ? "Confirm the holder this refusal names is not a live intake run, stop it or restart that host, then rerun the filing command."
        : `Confirm no intake run is live, then manually remove the claim directory: Remove-Item -LiteralPath '${lockPath.replaceAll("'", "''")}' -Recurse.` }] });
    expect(value.input.runPreflightCli).not.toHaveBeenCalled();
    expect(value.caller).not.toHaveBeenCalled();
    value.untouchedTransport();
  });

  it("replays the holder's filed candidate after waiting and acquiring the claim", async () => {
    const value = fixture();
    const claim = acquireExecutionClaim(resolveJournalPath("example-org/example-repo"), { mode: "execute" });
    let clock = NOW.getTime();
    let held = true;
    const sleep = vi.fn(async (milliseconds: number) => {
      clock += milliseconds;
      claim.release(); held = false;
      const holder = await value.execute();
      expect(holder.candidates[0]).toMatchObject({ disposition: "filed", issueNumber: 1901 });
    });
    try {
      const result = await runFileFindingCli({ ...value.input, sleep, now: () => new Date(clock),
        argv: [...value.input.argv, "--execute"], operatorToken: "fixture-token" });
      expect(result).toMatchObject({ status: "completed", candidates: [{ disposition: "replay", issueNumber: 1901 }],
        metrics: { durationsMs: { claimWait: 5_000 } } });
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(value.caller).toHaveBeenCalledTimes(1);
      expect(value.transport.createIssue).toHaveBeenCalledTimes(1);
    } finally { if (held) claim.release(); }
  });

  it("returns busy before census or assessment while a live process owns the real claim", async () => {
    const value = fixture();
    const claim = acquireExecutionClaim(resolveJournalPath("example-org/example-repo"), { mode: "execute" });
    const path = join(value.root, "busy-result.json");
    unlinkSync(value.censusPath);
    const sleep = vi.fn(async (_milliseconds: number) => {});
    const acquire = vi.spyOn(executionJournal, "acquireExecutionClaim");
    try {
      expect(await runFileFindingCommand({ ...value.input, sleep, argv: [...value.input.argv, "--execute", "--wait-minutes=0", `--result=${path}`], operatorToken: "fixture-token" })).toBe(5);
      expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ status: "busy", candidates: [{ disposition: "interrupted" }],
        metrics: { durationsMs: { claimWait: 0 } } });
      expect(sleep).not.toHaveBeenCalled();
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(claim.withOwnership(() => true)).toBe(true);
      expect(existsSync(value.censusPath)).toBe(false);
      expect(value.caller).not.toHaveBeenCalled();
      value.untouchedTransport();
    } finally { claim.release(); }
  });

  it.each([false, true])("returns no-op for an empty envelope without census, assessment, or claim (execute=%s)", async execute => {
    const value = fixture();
    value.write("finding.roadmap-outcomes.json", JSON.stringify(createOutcomeEnvelope({ ...value.envelope, candidates: [] })));
    unlinkSync(value.censusPath);
    const acquire = vi.spyOn(executionJournal, "acquireExecutionClaim");
    const result = await runFileFindingCli({ ...value.input, argv: [...value.input.argv, ...(execute ? ["--execute"] : [])],
      operatorToken: execute ? "fixture-token" : undefined });
    expect(result).toMatchObject({ status: "no-op", candidates: [] });
    expect(fileFindingExitCode(result)).toBe(0);
    expect(value.caller).not.toHaveBeenCalled();
    expect(value.input.runGit).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(existsSync(value.censusPath)).toBe(false);
    value.untouchedTransport();
  });

  it("does not overwrite a prior result or reinterpret publication failure as success", async () => {
    const value = fixture();
    const path = value.write("existing-result.json", "prior result");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runFileFindingCommand({ ...value.input, argv: [...value.input.argv, `--result=${path}`] })).toBe(4);
    expect(readFileSync(path, "utf8")).toBe("prior result");
    value.untouchedTransport();
  });

  it("keeps the caller's reported identity out of requestedAssessor on assessor rejection", async () => {
    const value = fixture();
    const implementation = value.caller.getMockImplementation()!;
    value.caller.mockImplementation(async call => ({ ...await implementation(call), provider: "other-provider", model: "served-model" }));
    const path = join(value.root, "identity-result.json");
    expect(await runFileFindingCommand({ ...value.input, argv: [...value.input.argv, `--result=${path}`] })).toBe(4);
    const result = JSON.parse(readFileSync(path, "utf8"));
    expect(result.requestedAssessor.model).not.toBe("served-model");
    expect(result.requestedAssessor.provider).not.toBe("other-provider");
    expect(result.candidates[0].disposition).toBe("interrupted");
  });

  it.each(["census_unavailable", "operator_token_missing"])("writes a fixing command for %s", async reason => {
    const value = fixture();
    if (reason === "census_unavailable") unlinkSync(value.censusPath);
    const resultPath = join(value.root, "refused-result.json");
    const code = await runFileFindingCommand({ ...value.input, argv: [...value.input.argv, "--execute", `--result=${resultPath}`],
      operatorToken: reason === "operator_token_missing" ? undefined : "fixture-token",
    });
    expect(code).toBe(1);
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    expect(result.candidates[0]).toMatchObject({ disposition: "refused", reason: expect.stringContaining(reason), fixingCommand: expect.any(String) });
    if (reason.startsWith("census")) {
      expect(result.candidates[0].fixingCommand).toContain("run-github-issue-roadmap-file-finding.ps1");
      expect(result.candidates[0].fixingCommand).not.toContain("preflight");
    } else expect(result.candidates[0].fixingCommand).toContain("-Execute");
    value.untouchedTransport();
  });

  it.each(["filed", "replay", "dry-run", "hold", "refused"] as const)(
    "writes the complete %s result to --result and returns its command exit code", async status => {
      const value = fixture();
      if (status === "replay" || status === "hold") {
        const marker = markerBlock(value.envelope, value.envelope.candidates[0]);
        const issues = status === "replay" ? [censusIssue({ number: 7, body: marker })] : [
          censusIssue({ number: 7, body: marker }), censusIssue({ number: 8, databaseId: 8, nodeId: "I_8", body: marker }),
        ];
        value.publishCensus(stackSnapshot(value.envelope, censusPass(issues)));
      }
      if (status === "refused") value.transport.verifyClassifications.mockResolvedValue(false);
      const resultPath = join(value.root, "operator result.json");
      const code = await runFileFindingCommand({ ...value.input,
        argv: [...value.input.argv, `--result=${resultPath}`, ...(status === "dry-run" ? [] : ["--execute"])],
        operatorToken: status === "dry-run" ? undefined : "fixture-token",
      });
      expect(code).toBe(status === "hold" || status === "refused" ? 1 : 0);
      const result = JSON.parse(readFileSync(resultPath, "utf8")) as FileFindingResult;
      expect(result.status).toBe(status === "dry-run" ? "dry-run" : "completed");
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0].disposition).toBe(status);
      if (status === "hold") expect(result.candidates[0]).toMatchObject({ competingIssues: [7, 8] });
      if (status === "refused") expect(result.candidates[0].fixingCommand).toBeTruthy();
      expect(result).toEqual(JSON.parse(readFileSync(join(result.runRoot, "result.json"), "utf8")));
      expect(value.log.mock.calls.some(([line]) => line === readFileSync(resultPath, "utf8"))).toBe(true);
    });

  it("exits 1 on a credential refusal and writes a per-candidate result without Git or model calls", async () => {
    const value = fixture();
    const resultPath = join(value.root, "operator result.json");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await runFileFindingCommand({ ...value.input, argv: [...value.input.argv, `--result=${resultPath}`, "--execute"] });
    expect(code).toBe(1);
    expect(error).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toMatchObject({ candidates: [{ disposition: "refused", reason: expect.stringContaining("operator_token_missing:") }] });
    expect(value.input.runGit).not.toHaveBeenCalled();
    expect(value.caller).not.toHaveBeenCalled();
    value.untouchedTransport();
  });

  it("bounds a looping agent editing its source across separate immediate invocations", async () => {
    const value = fixture();
    allowCapture(value);
    const fingerprints = new Set<string>();
    const ceiling = intakeApply.INTAKE_CREATE_LIMITS.repositoryCreates;
    for (let index = 0; index <= ceiling; index += 1) {
      const source = `${SOURCE}Revision ${index}\n`;
      const hash = outcomeSourceContentSha256(Buffer.from(source));
      const envelope = createOutcomeEnvelope({ ...value.envelope,
        artifact: { ...value.envelope.artifact, revisionSha256: hash },
        candidates: value.envelope.candidates.map(({ sourceFingerprint: _source, emissionContentSha256: _emission, ...candidate }) => ({
          ...candidate, stableOutcomeId: `${candidate.stableOutcomeId}-revision-${index}`,
          evidence: candidate.evidence.map((citation) => ({ ...citation, contentSha256: hash })),
          provenance: candidate.provenance.map((citation) => ({ ...citation, contentSha256: hash })),
        })),
      });
      fingerprints.add(envelope.candidates[0].sourceFingerprint);
      expect(fingerprints.size).toBe(index + 1);
      for (const locator of [envelope.artifact.sourceLocator, ...envelope.candidates[0].evidence.map((citation) => citation.sourceLocator)]) {
        value.write(locator, source);
      }
      writeFileSync(value.candidatePath, JSON.stringify(envelope));
      value.input.runGit.mockImplementation((_cwd, args) => {
        if (args[0] === "rev-parse") {
          if (args.includes("--is-shallow-repository")) return "false";
          if (args[2] === "HEAD^{commit}") return HEAD;
          if (args[2].startsWith(`${HEAD}:`)) return createHash("sha1").update(source).digest("hex");
          if (args[2] === "origin/main^{commit}" || args[2] === `${MAIN}^{commit}`) return MAIN;
        }
        if (args[0] === "cat-file" && args[1] === "blob" && args[2] === createHash("sha1").update(source).digest("hex")) return Buffer.from(source).toString("base64");
        if (args[0] === "ls-tree" || args[0] === "log") return "";
        throw new Error(`Unexpected git command ${args.join(" ")}`);
      });
      value.openTransport.mockClear();
      for (const method of Object.values(value.transport)) method.mockClear();
      const result = await value.execute();
      expect(fileFindingExitCode(result)).toBe(index < ceiling ? 0 : 2);
      if (index < ceiling) {
        expect(result.candidates[0].disposition).toBe("filed");
        expect(value.transport.createIssue).toHaveBeenCalledOnce();
      }
      else {
        expect(result.candidates[0].disposition).toBe("pending");
        expect(result.candidates[0].reason).toContain("repository_create_budget_exhausted");
        expect(await runFileFindingCommand({ ...value.input, argv: [...value.input.argv, "--execute"], operatorToken: "fixture-token" })).toBe(2);
        value.untouchedTransport();
      }
    }
    expect(fingerprints.size).toBe(ceiling + 1);
  }, 15000); // Twelve pipelines with real claim/journal fsyncs can exceed 5s on Windows.

  it("dry-runs the real pipeline, prints the exact payload, and writes only working artifacts with zero transport", async () => {
    const value = fixture();
    const before = files(value.root);
    const result = await runFileFindingCli(value.input);
    expect(result.status).toBe("dry-run");
    expect(value.caller).toHaveBeenCalledOnce();
    const writes = result.apply!.writes;
    expect(writes).toHaveLength(1);
    expect(writes[0].issue?.title).toBe(value.envelope.candidates[0].outcome.title);
    expect(writes[0].issue?.body).toContain(value.envelope.candidates[0].outcome.completionRule);
    expect(writes[0].issue?.body).toContain(markerBlock(value.envelope, value.envelope.candidates[0]));
    expect(writes[0].issue?.body).toMatch(/Evidence coverage: \d+ of \d+ issue bodies shown/);
    expect(writes[0].classifications).toEqual([
      { fieldName: "Type", value: "Task" }, { fieldName: "Priority", value: "P2" }, { fieldName: "Effort", value: "Medium" },
    ]);
    const output = value.log.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain(JSON.stringify(writes[0].issue!.title));
    expect(output).toContain(JSON.stringify(writes[0].issue!.body));
    expect(output).toContain('"classifications"');
    const after = files(value.root);
    for (const [path, bytes] of Object.entries(before)) expect(after[path]).toBe(bytes);
    const added = Object.keys(after).filter((path) => !(path in before));
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((path) => path.startsWith(relative(value.root, result.runRoot)))).toBe(true);
    expect(existsSync(join(dirname(resolveJournalPath("example-org/example-repo")), "execution.lock"))).toBe(false);
    value.untouchedTransport();
    const evidenceRoot = join(result.runRoot, "artifacts/github-issue-roadmap");
    expect(verifyRunEvidence({
      evidenceBytes: readFileSync(join(evidenceRoot, "run-evidence.json")),
      plan: JSON.parse(readFileSync(join(evidenceRoot, "approval-plan.json"), "utf8")), repository: "example-org/example-repo",
      files: (name) => readFileSync(join(evidenceRoot, name)),
    }).ok).toBe(true);
  });

  it("executes one create with preflight, durable intent, claim fencing, classifications, read-back, and journal complete", async () => {
    const value = fixture();
    const journalPath = resolveJournalPath("example-org/example-repo");
    value.transport.createIssue.mockImplementation(async () => {
      expect(existsSync(join(dirname(journalPath), "execution.lock/owner.json"))).toBe(true);
      expect(readJournal(journalPath).records).toEqual([expect.objectContaining({ event: "intent" })]);
      return { issueNumber: 1901, issueId: "I_1901" };
    });
    const result = await value.execute();
    expect(result.candidates[0].disposition).toBe("filed");
    expect(result.candidates[0].issueNumber).toBe(1901);
    expect(value.transport.createIssue).toHaveBeenCalledOnce();
    expect(value.transport.preflightClassifications).toHaveBeenCalledOnce();
    expect(value.transport.applyClassification.mock.calls).toEqual(result.apply!.writes[0].classifications.map((classification) =>
      ["example-org/example-repo", 1901, classification, expect.any(Function)]));
    expect(value.transport.verifyClassifications).toHaveBeenCalledOnce();
    expect(value.transport.verifyClassifications).toHaveBeenCalledWith("example-org/example-repo", 1901, result.apply!.writes[0].classifications);
    expect(readJournal(journalPath).records).toEqual([
      expect.objectContaining({ event: "intent" }), expect.objectContaining({ event: "created" }), expect.objectContaining({ event: "complete", issueNumber: 1901 }),
    ]);
    expect(existsSync(join(dirname(journalPath), "execution.lock"))).toBe(false);
    expect(value.transport.appendEvidenceComment).not.toHaveBeenCalled();
    expect(value.transport.closeIssue).not.toHaveBeenCalled();
    expect(value.log).toHaveBeenCalledWith("Issue #1901 complete and verified.");
  });

  it("replays a successful create when a fresh census contains its own issue marker", async () => {
    const value = fixture();
    const first = await value.execute();
    expect(first.candidates[0]).toMatchObject({ disposition: "filed", issueNumber: 1901 });
    const issueBody = first.apply!.writes[0].issue!.body;
    value.publishCensus(stackSnapshot(value.envelope, censusPass([
      censusIssue({ number: 1901, body: issueBody }),
    ])));
    const journalBefore = readFileSync(resolveJournalPath("example-org/example-repo"));
    value.openTransport.mockClear();
    for (const method of Object.values(value.transport)) method.mockClear();
    value.caller.mockClear();
    const result = await value.execute();
    expect(result.candidates[0]).toMatchObject({ disposition: "replay", reason: "already_filed", issueNumber: 1901 });
    expect(fileFindingExitCode(result)).toBe(0);
    expect(readFileSync(resolveJournalPath("example-org/example-repo"))).toEqual(journalBefore);
    expect(value.caller).not.toHaveBeenCalled();
    value.untouchedTransport();
  });

  it("short-circuits a complete current emission before census, assessment, or claim", async () => {
    const value = fixture();
    await value.execute();
    const before = readFileSync(resolveJournalPath("example-org/example-repo"));
    value.openTransport.mockClear();
    for (const method of Object.values(value.transport)) method.mockClear();
    value.caller.mockClear();
    unlinkSync(value.censusPath);
    const claim = acquireExecutionClaim(resolveJournalPath("example-org/example-repo"), { mode: "execute" });
    try {
      const result = await value.execute();
      expect(result.candidates[0]).toMatchObject({ disposition: "replay", issueNumber: 1901 });
      expect(result.apply).toBeUndefined();
      expect(readFileSync(resolveJournalPath("example-org/example-repo"))).toEqual(before);
      expect(value.caller).not.toHaveBeenCalled();
      value.untouchedTransport();
    } finally { claim.release(); }
  });

  it.each(["create_issue", "append_evidence"] as const)("replays every complete %s in an envelope without a census or assessment", async action => {
    const value = fixture();
    const envelope = stackEnvelope(2);
    value.write("finding.roadmap-outcomes.json", JSON.stringify(envelope));
    seedComplete(envelope, action);
    unlinkSync(value.censusPath);
    const result = await value.execute();
    expect(result.candidates).toEqual(envelope.candidates.map((candidate, index) => expect.objectContaining({
      sourceFingerprint: candidate.sourceFingerprint, stableOutcomeId: candidate.stableOutcomeId, disposition: "replay", issueNumber: 1901 + index,
    })));
    expect(fileFindingExitCode(result)).toBe(0);
    expect(value.caller).not.toHaveBeenCalled();
    expect(value.input.runGit.mock.calls.every(([, args]) => ["rev-parse", "log"].includes(args[0]))).toBe(true);
    value.untouchedTransport();
  });

  it("recaptures a census predating an earlier completed create and still reports replay", async () => {
    const value = fixture();
    expect((await value.execute()).candidates[0].disposition).toBe("filed");
    const nextEmission = createOutcomeEnvelope({ ...value.envelope,
      candidates: value.envelope.candidates.map(({ sourceFingerprint: _fingerprint, emissionContentSha256: _emission, ...candidate }) => ({
        ...candidate, evidence: [...candidate.evidence, { ...candidate.evidence[0], id: "additional-evidence" }],
      })),
    });
    expect(nextEmission.candidates[0].sourceFingerprint).toBe(value.envelope.candidates[0].sourceFingerprint);
    expect(nextEmission.candidates[0].emissionContentSha256).not.toBe(value.envelope.candidates[0].emissionContentSha256);
    value.write("finding.roadmap-outcomes.json", JSON.stringify(nextEmission));
    const censusBytes = readFileSync(value.censusPath);
    allowCapture(value);
    value.openTransport.mockClear();
    for (const method of Object.values(value.transport)) method.mockClear();
    const result = await value.execute();
    expect(result.candidates[0]).toMatchObject({ disposition: "replay", reason: "already_filed", issueNumber: 1901 });
    expect(result.apply?.ledgerRecords[0].durableState).toBe("complete");
    expect(readFileSync(value.censusPath)).not.toEqual(censusBytes);
    expect(result.metrics?.censusMode).toBe("capture");
    expect(fileFindingExitCode(result)).toBe(0);
    value.untouchedTransport();
  });

  it("assesses a new emission of a completed fingerprint and compiles a marker-match append", async () => {
    const value = fixture();
    seedComplete(value.envelope);
    const envelope = createOutcomeEnvelope({ ...value.envelope, candidates: value.envelope.candidates.map(({
      sourceFingerprint: _fingerprint, emissionContentSha256: _emission, ...candidate
    }) => ({ ...candidate, evidence: [...candidate.evidence, { ...candidate.evidence[0], id: "new-evidence" }] })) });
    expect(envelope.candidates[0].sourceFingerprint).toBe(value.envelope.candidates[0].sourceFingerprint);
    expect(envelope.candidates[0].emissionContentSha256).not.toBe(value.envelope.candidates[0].emissionContentSha256);
    value.write("finding.roadmap-outcomes.json", JSON.stringify(envelope));
    value.publishCensus(stackSnapshot(envelope, censusPass([
      censusIssue({ number: 1901, body: markerBlock(value.envelope, value.envelope.candidates[0]) }),
    ])));
    const result = await value.execute();
    expect(value.caller).toHaveBeenCalledOnce();
    expect(result.candidates[0]).toMatchObject({ disposition: "appended", issueNumber: 1901 });
    expect(value.transport.appendEvidenceComment).toHaveBeenCalledOnce();
    expect(value.transport.createIssue).not.toHaveBeenCalled();
    expect(value.transport.closeIssue).not.toHaveBeenCalled();
  });

  it.each([false, true])("excludes complete candidates from assessment and recapture (refresh=%s)", async refresh => {
    const value = fixture();
    const pending = value.envelope.candidates[0];
    const { sourceFingerprint: _fingerprint, emissionContentSha256: _emission, ...material } = pending;
    void _fingerprint; void _emission;
    const completed = createOutcomeEnvelope({ ...value.envelope, candidates: [{ ...material, stableOutcomeId: "completed-outcome" }] });
    seedComplete(completed);
    value.publishCensus(value.census);
    const envelope = { ...value.envelope, candidates: [completed.candidates[0], pending] };
    value.write("finding.roadmap-outcomes.json", JSON.stringify(envelope));
    const now = vi.fn(() => NOW);
    const runners = captureRunners(value, now);
    const assessor = value.caller.getMockImplementation()!;
    value.caller.mockImplementation(async call => {
      const response = await assessor(call);
      if (refresh) now.mockReturnValue(new Date("2026-08-20T13:00:01.000Z"));
      return response;
    });
    const result = await runFileFindingCli({ ...value.input, ...runners, now,
      argv: [...value.input.argv, "--execute"], operatorToken: "fixture-token" });
    expect(result.candidates.map(candidate => candidate.disposition)).toEqual(["replay", "filed"]);
    expect(value.caller).toHaveBeenCalledTimes(refresh ? 2 : 1);
    for (const [call] of value.caller.mock.calls) expect((call.evidence.candidateEnvelope as OutcomeEnvelope).candidates).toEqual([pending]);
    expect(runners.runIntakePreflightCli).toHaveBeenCalledTimes(refresh ? 1 : 0);
    if (refresh) {
      const captureArgv = runners.runIntakePreflightCli.mock.calls[0][0];
      expect(JSON.parse(readFileSync(runners.outputPath(captureArgv, "candidate"), "utf8")).candidates).toEqual([pending]);
    }
  });

  it.each([false, true])("preserves the run outcome when release throws (run fails=%s)", async fails => {
    const value = fixture();
    const originalFailure = new Error("original assessment failure");
    const releaseFailure = new Error("release fixture failure");
    const acquire = executionJournal.acquireExecutionClaim;
    vi.spyOn(executionJournal, "acquireExecutionClaim").mockImplementation((...args) => {
      const claim = acquire(...args);
      return { ...claim, release: () => { claim.release(); throw releaseFailure; } };
    });
    if (fails) {
      value.caller.mockRejectedValue(originalFailure);
      const error = await value.execute().catch(error => error);
      expect(error.message).toContain("assessor_unavailable: original assessment failure");
      expect(error.cause.cause).toBe(originalFailure);
      expect(error.suppressed).toContain(releaseFailure);
      value.untouchedTransport();
    } else {
      const result = await value.execute();
      expect(result.candidates[0]).toMatchObject({ disposition: "filed", issueNumber: 1901 });
      expect(result.infrastructureNotes).toEqual(["claim_release_failed: release fixture failure"]);
      expect(result.status).toBe("infrastructure");
      expect(fileFindingExitCode(result)).toBe(4);
      expect(JSON.parse(readFileSync(join(result.runRoot, "result.json"), "utf8"))).toEqual(result);
      expect(value.transport.createIssue).toHaveBeenCalledOnce();
    }
  });

  it("holds the same real claim from assessment through apply and releases it once", async () => {
    const value = fixture();
    const journalPath = resolveJournalPath("example-org/example-repo");
    const ownerPath = join(dirname(journalPath), "execution.lock", "owner.json");
    let ownerBytes: Buffer;
    const assessor = value.caller.getMockImplementation()!;
    value.caller.mockImplementation(async call => {
      ownerBytes = readFileSync(ownerPath);
      expect(() => acquireExecutionClaim(journalPath, { mode: "execute" })).toThrow(/held by pid/);
      return assessor(call);
    });
    value.transport.createIssue.mockImplementation(async () => {
      expect(readFileSync(ownerPath)).toEqual(ownerBytes);
      return { issueNumber: 1901, issueId: "I_1901" };
    });
    expect((await value.execute()).candidates[0].disposition).toBe("filed");
    expect(existsSync(dirname(ownerPath))).toBe(false);
    const next = acquireExecutionClaim(journalPath, { mode: "execute" });
    next.release();
  });

  it.each([false, true])("refuses a stale supplied census and releases its claim (execute=%s)", async (execute) => {
    const value = fixture();
    const now = () => new Date("2026-08-20T13:00:01.000Z");
    const runners = captureRunners(value, now);
    const before = JSON.stringify(value.census);
    const suppliedPath = value.write("supplied-census.json", before);
    const storeBefore = readFileSync(value.censusPath);
    await expect(runFileFindingCli({ ...value.input, ...runners, now,
      argv: [...value.input.argv.filter(arg => !arg.startsWith("--census=")), `--census=${suppliedPath}`, ...(execute ? ["--execute"] : [])], operatorToken: execute ? "fixture-token" : undefined,
    })).rejects.toThrow("census_stale:");
    expect(runners.runPreflightCli).not.toHaveBeenCalled();
    expect(runners.runIntakePreflightCli).not.toHaveBeenCalled();
    expect(value.caller).not.toHaveBeenCalled();
    expect(readFileSync(suppliedPath, "utf8")).toBe(before);
    expect(readFileSync(value.censusPath)).toEqual(storeBefore);
    expect(process.cwd()).toBe(runners.callerCwd);
    expect(existsSync(join(dirname(resolveJournalPath("example-org/example-repo")), "execution.lock"))).toBe(false);
  });

  it.each(["missing", "malformed"])("refuses a %s supplied census", async kind => {
    const value = fixture();
    const suppliedPath = join(value.root, "supplied-census.json");
    if (kind === "malformed") writeFileSync(suppliedPath, "{}");
    const runners = captureRunners(value);
    await expect(runFileFindingCli({ ...value.input, ...runners, argv: [...value.input.argv, `--census=${suppliedPath}`] })).rejects.toThrow("census_stale:");
    expect(runners.runPreflightCli).not.toHaveBeenCalled();
    expect(runners.runIntakePreflightCli).not.toHaveBeenCalled();
    expect(process.cwd()).toBe(runners.callerCwd);
    value.untouchedTransport();
  });

  it("surfaces a deterministic duplicate-marker hold and releases its claim", async () => {
    const value = fixture();
    const marker = markerBlock(value.envelope, value.envelope.candidates[0]);
    const snapshot = stackSnapshot(value.envelope, censusPass([
      censusIssue({ number: 7, body: marker }), censusIssue({ number: 8, databaseId: 8, nodeId: "I_8", body: marker }),
    ]));
    value.publishCensus(snapshot);
    const result = await value.execute();
    expect(result.candidates[0].disposition).toBe("hold");
    expect(result.candidates[0].reason).toBeTruthy();
    expect(value.log.mock.calls.flat().join("\n")).toContain('"hold"');
    expect(existsSync(join(dirname(resolveJournalPath("example-org/example-repo")), "execution.lock"))).toBe(false);
    value.untouchedTransport();
  });

  it("refuses a missing execute token before Git, model, artifacts, claim or network", async () => {
    const value = fixture();
    const before = files(value.root);
    await expect(runFileFindingCli({ ...value.input, argv: [...value.input.argv, "--execute"] })).rejects.toThrow("operator_token_missing:");
    expect(value.input.runGit).not.toHaveBeenCalled();
    expect(value.caller).not.toHaveBeenCalled();
    expect(files(value.root)).toEqual(before);
    value.untouchedTransport();
  });

  it.each([false, true])("checks a real committed LF source against CRLF working bytes (changed word=%s)", async (changedWord) => {
    const value = fixture();
    const git = (args: readonly string[]) => runCredentialCleanGit(value.root, args);
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Finding test"]);
    git(["config", "user.email", "finding@example.test"]);
    expect(() => git(["config", "--local", "--get", "core.autocrlf"])).toThrow();
    git(["add", "."]);
    git(["commit", "-m", "Committed LF finding"]);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    const locators = new Set([value.envelope.artifact.sourceLocator,
      ...value.envelope.candidates.flatMap(candidate => [...candidate.evidence, ...candidate.provenance]
        .map(citation => citation.sourceLocator))]);
    for (const locator of locators) {
      const committed = Buffer.from(runCredentialCleanGit(value.root, ["cat-file", "blob", `HEAD:${locator}`], { output: "base64" }), "base64");
      expect(committed.equals(Buffer.from(SOURCE))).toBe(true);
      value.write(locator, (changedWord ? SOURCE.replace("finding", "changed") : SOURCE).replace(/\n/g, "\r\n"));
    }
    // Bind the changed bytes into citations too, so only the committed-blob check
    // can reject the changed word (not a stale evidence hash).
    if (changedWord) {
      const hash = outcomeSourceContentSha256(Buffer.from(SOURCE.replace("finding", "changed")));
      const envelope = createOutcomeEnvelope({ ...value.envelope,
        candidates: value.envelope.candidates.map(({ sourceFingerprint: _fingerprint, emissionContentSha256: _emission, ...candidate }) => ({
          ...candidate,
          evidence: candidate.evidence.map(citation => ({ ...citation, contentSha256: hash })),
          provenance: candidate.provenance.map(citation => ({ ...citation, contentSha256: hash })),
        })),
      });
      writeFileSync(value.candidatePath, JSON.stringify(envelope));
    }
    const before = files(value.root);
    const result = runFileFindingCli({ ...value.input, runGit: runCredentialCleanGit });
    if (changedWord) {
      await expect(result).rejects.toThrow("source_not_committed:");
      expect(files(value.root)).toEqual(before);
      expect(value.caller).not.toHaveBeenCalled();
    } else {
      expect((await result).status).toBe("dry-run");
      expect(value.caller).toHaveBeenCalledOnce();
    }
    value.untouchedTransport();
  });

  it.each(["modified", "untracked", "citation-drift"])("refuses %s source with a named reason and no artifacts", async (kind) => {
    const value = fixture();
    if (kind === "modified") value.write(value.envelope.artifact.sourceLocator, "# Uncommitted change\n");
    else if (kind === "untracked") {
      const implementation = value.input.runGit.getMockImplementation()!;
      value.input.runGit.mockImplementation((cwd, args) => {
        if (args.includes("--is-shallow-repository")) return "false";
        if (args[0] === "rev-parse" && args[2].startsWith(`${HEAD}:`)) throw new Error("Not a committed object");
        return implementation(cwd, args);
      });
    }
    else {
      const envelope = createOutcomeEnvelope({ ...value.envelope,
        candidates: value.envelope.candidates.map(({ sourceFingerprint: _fingerprint, emissionContentSha256: _emission, ...candidate }) => ({
          ...candidate, evidence: candidate.evidence.map((citation) => ({ ...citation, contentSha256: "a".repeat(64) })),
        })),
      });
      value.write("finding.roadmap-outcomes.json", JSON.stringify(envelope));
    }
    const before = files(value.root);
    await expect(value.execute()).rejects.toThrow("source_not_committed:");
    expect(files(value.root)).toEqual(before);
    expect(value.caller).not.toHaveBeenCalled();
    value.untouchedTransport();
  });

  it("refreshes an expired census and reassesses once in a new exchange before apply", async () => {
    const value = fixture();
    const now = vi.fn(() => NOW);
    const runners = captureRunners(value, now);
    let originalArtifacts: Record<string, string> = {};
    const implementation = value.caller.getMockImplementation()!;
    value.caller.mockImplementation(async (call) => {
      const response = await implementation(call);
      if (value.caller.mock.calls.length === 1) originalArtifacts = files(value.root);
      now.mockReturnValue(new Date("2026-08-20T13:00:01.000Z"));
      return response;
    });
    const result = await runFileFindingCli({ ...value.input, ...runners, now, argv: [...value.input.argv, "--execute"], operatorToken: "fixture-token" });
    expect(result.candidates[0].disposition).toBe("filed");
    expect(value.caller).toHaveBeenCalledTimes(2);
    expect(runners.runPreflightCli).toHaveBeenCalledOnce();
    expect(runners.runIntakePreflightCli).toHaveBeenCalledOnce();
    expect(value.transport.createIssue).toHaveBeenCalledOnce();
    expect(existsSync(join(result.runRoot, "exchange"))).toBe(true);
    expect(existsSync(join(result.runRoot, "exchange-refresh-1"))).toBe(true);
    const after = files(value.root);
    for (const [path, bytes] of Object.entries(originalArtifacts).filter(([path]) => !path.startsWith("journal") && path !== relative(value.root, value.censusPath))) {
      expect(after[path]).toBe(bytes);
    }
    const secondSnapshot = value.caller.mock.calls[1][0].evidence.intakeSnapshot as IntakeSnapshotV1;
    expect(secondSnapshot.contentSha256).not.toBe(value.census.contentSha256);
    expect(secondSnapshot.candidateSha256).toBe(canonicalJsonSha256(value.envelope));
    expect(existsSync(join(dirname(resolveJournalPath("example-org/example-repo")), "execution.lock"))).toBe(false);
  });

  it("bounds expiry refresh to one reassessment when the replacement also expires", async () => {
    const value = fixture();
    const now = vi.fn(() => NOW);
    const runners = captureRunners(value, now);
    const implementation = value.caller.getMockImplementation()!;
    value.caller.mockImplementation(async call => {
      const response = await implementation(call);
      now.mockReturnValue(new Date(now().getTime() + 3_600_001));
      return response;
    });
    const resultPath = join(value.root, "expiry-result.json");
    expect(await runFileFindingCommand({ ...value.input, ...runners, now,
      argv: [...value.input.argv, "--execute", `--result=${resultPath}`], operatorToken: "fixture-token",
    })).toBe(1);
    expect(JSON.parse(readFileSync(resultPath, "utf8")).candidates[0]).toMatchObject({ disposition: "refused",
      reason: expect.stringContaining("census_stale:"), fixingCommand: expect.stringContaining("run-github-issue-roadmap-file-finding.ps1") });
    expect(value.caller).toHaveBeenCalledTimes(2);
    expect(runners.runIntakePreflightCli).toHaveBeenCalledOnce();
    expect(existsSync(join(dirname(resolveJournalPath("example-org/example-repo")), "execution.lock"))).toBe(false);
    value.untouchedTransport();
  });

  it("checks expiry again immediately before apply even when assessment and shadow were fresh", async () => {
    const value = fixture();
    const now = vi.fn(() => NOW);
    const runners = captureRunners(value, now);
    const shadow = intakeShadow.runIntakeShadow;
    vi.spyOn(intakeShadow, "runIntakeShadow").mockImplementation(input => {
      const result = shadow(input);
      now.mockReturnValue(new Date("2026-08-20T13:00:01.000Z"));
      return result;
    });
    const result = await runFileFindingCli({ ...value.input, ...runners, now,
      argv: [...value.input.argv, "--execute"], operatorToken: "fixture-token" });
    expect(result.candidates[0].disposition).toBe("filed");
    expect(value.caller).toHaveBeenCalledTimes(2);
    expect(runners.runIntakePreflightCli).toHaveBeenCalledOnce();
    expect(value.transport.createIssue).toHaveBeenCalledOnce();
    const refreshedRoot = join(result.runRoot, "artifacts/github-issue-roadmap/refresh-1");
    expect(verifyRunEvidence({ evidenceBytes: readFileSync(join(refreshedRoot, "run-evidence.json")),
      plan: JSON.parse(readFileSync(join(refreshedRoot, "approval-plan.json"), "utf8")), repository: "example-org/example-repo",
      files: name => readFileSync(join(refreshedRoot, name)),
    }).ok).toBe(true);
  });

  it.each([true, false])("reconciles a crash after create intent with a dead owner without a second create (marker=%s)", async hasMarker => {
    const value = fixture();
    const preview = await runFileFindingCli(value.input);
    const journalPath = resolveJournalPath("example-org/example-repo");
    const intent = executionEvent({
      event: "intent", now: new Date("2026-08-20T11:59:59.000Z"), write: preview.apply!.writes[0],
      decisionContentSha256: preview.apply!.ledgerRecords[0].decisionContentSha256,
    });
    const body = markerBlock(value.envelope, value.envelope.candidates[0]);
    value.publishCensus(stackSnapshot(value.envelope, censusPass([censusIssue({ body: hasMarker ? body : "" })])));
    // The child journals intent under its own real claim, then exits without release.
    const runnerPath = value.write("crash-after-intent.ts", `
import { acquireExecutionClaim, appendJournal } from ${JSON.stringify(resolve("scripts/lib/github-issue-roadmap/intake-execution-journal.ts"))};
const path = ${JSON.stringify(journalPath)};
const claim = acquireExecutionClaim(path, { mode: "execute" });
claim.withOwnership(() => appendJournal(path, ${JSON.stringify(intent)}));
`);
    const child = spawnSync(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), runnerPath],
      { windowsHide: true, env: { ...process.env }, encoding: "utf8", timeout: 15000 });
    expect(child.status).toBe(0);
    const ownerPath = join(dirname(journalPath), "execution.lock", "owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    expect(owner.pid).not.toBe(process.pid);
    expect(() => process.kill(owner.pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    value.transport.fetchIssue.mockResolvedValue({ number: 7, id: 7, nodeId: "I_7", body, isPullRequest: false,
      htmlUrl: "https://github.com/example-org/example-repo/issues/7", createdAt: "2026-08-20T12:00:00.000Z", fetchedAt: NOW.toISOString() });

    allowCapture(value);
    const result = await value.execute();

    expect(result.candidates[0]).toMatchObject(hasMarker ? { disposition: "filed", issueNumber: 7 }
      : { disposition: "refused", reason: expect.stringContaining("no_owner:"), fixingCommand: expect.stringContaining("Do not redispatch an unresolved create") });
    expect(value.transport.createIssue).not.toHaveBeenCalled();
    expect(value.transport.fetchIssue).toHaveBeenCalledTimes(hasMarker ? 1 : 0);
    expect(readJournal(journalPath).records).toEqual(hasMarker ? [
      expect.objectContaining({ event: "intent" }), expect.objectContaining({ event: "reconciled" }), expect.objectContaining({ event: "complete", issueNumber: 7 }),
    ] : [expect.objectContaining({ event: "intent" }), expect.objectContaining({ event: "create_unresolved" })]);
    expect(existsSync(dirname(ownerPath))).toBe(false);
  });

  it("never retries an unresolved create", async () => {
    const value = fixture();
    allowCapture(value);
    value.transport.createIssue.mockRejectedValue(new Error("Connection lost after dispatch"));
    const first = await value.execute();
    expect(first.candidates[0].disposition).toBe("refused");
    expect(readJournal(resolveJournalPath("example-org/example-repo")).records).toContainEqual(expect.objectContaining({ event: "create_unresolved" }));
    value.openTransport.mockClear();
    for (const method of Object.values(value.transport)) method.mockClear();
    const second = await value.execute();
    expect(second.candidates[0].disposition).toBe("refused");
    value.untouchedTransport();
  });

  it("does not report success when classification read-back fails", async () => {
    const value = fixture();
    value.transport.verifyClassifications.mockResolvedValue(false);
    const result = await value.execute();
    expect(result.candidates[0].disposition).toBe("refused");
    expect(result.candidates[0].issueNumber).toBeUndefined();
    expect(readJournal(resolveJournalPath("example-org/example-repo")).records).not.toContainEqual(expect.objectContaining({ event: "complete" }));
    expect(value.log).not.toHaveBeenCalledWith("Issue #1901 complete and verified.");
  });

  it("accepts an explicit eligible census and leaves the cache untouched", async () => {
    const value = fixture();
    const path = value.write("external-census.json", readFileSync(value.censusPath, "utf8"));
    unlinkSync(value.censusPath);
    const result = await runFileFindingCli({ ...value.input, argv: [...value.input.argv.filter(arg => !arg.startsWith("--census=")), `--census=${path}`] });
    expect(result.status).toBe("dry-run");
    expect(value.input.runPreflightCli).not.toHaveBeenCalled();
    expect(value.input.runIntakePreflightCli).not.toHaveBeenCalled();
    expect(existsSync(value.censusPath)).toBe(false);
    value.untouchedTransport();
  });

  it("files five candidates in envelope order with five apply calls and one assessment", async () => {
    const value = fixture(5);
    const apply = vi.spyOn(intakeApply, "runIntakeApplyCli");
    const result = await value.execute();
    expect(result.candidates.map(candidate => candidate.disposition)).toEqual(Array(5).fill("filed"));
    expect(result.candidates.map(candidate => candidate.issueNumber)).toEqual([1901, 1902, 1903, 1904, 1905]);
    expect(value.transport.createIssue).toHaveBeenCalledTimes(5);
    expect(apply).toHaveBeenCalledTimes(5);
    expect(value.caller).toHaveBeenCalledOnce();
    expect(value.input.runPreflightCli).not.toHaveBeenCalled();
    expect(new Set(apply.mock.calls.map(([input]) => input.heldClaim)).size).toBe(1);
    const applied: intakeApply.IntakeApplyResult[] = await Promise.all(apply.mock.results.map(call => call.value));
    expect(applied.flatMap(result => result.writes.map(write => write.sourceFingerprint))).toEqual(value.envelope.candidates.map(candidate => candidate.sourceFingerprint));
    for (const result of applied) expect(result.writes).toHaveLength(1);
    expect(fileFindingExitCode(result)).toBe(0);
  });

  it.each([401, 403, 429, 503])("stops after a session-wide HTTP %s on the second create", async status => {
    const value = fixture(3);
    value.transport.createIssue.mockResolvedValueOnce({ issueNumber: 1901, issueId: "I_1901" })
      .mockRejectedValueOnce(Object.assign(new Error(`HTTP ${status}`), { status }));
    const result = await value.execute();
    expect(result.candidates.map(candidate => candidate.disposition)).toEqual(["filed", "interrupted", "interrupted"]);
    expect(result.status).toBe("infrastructure");
    expect(result.apply?.aborted?.reason).toBe("session_scope_fault");
    expect(fileFindingExitCode(result)).toBe(4);
    expect(value.transport.createIssue).toHaveBeenCalledTimes(2);
    expect(value.transport.preflightClassifications).toHaveBeenCalledTimes(2);
    expect(value.transport.verifyClassifications).toHaveBeenCalledOnce();
    expect(value.transport.applyClassification).toHaveBeenCalledTimes(3);
    expect(value.transport.appendEvidenceComment).not.toHaveBeenCalled();
    expect(value.transport.fetchIssue).not.toHaveBeenCalled();
  });

  it.each(["dispatch", "classification"])("carries consecutive %s failures across apply calls", async stage => {
    const value = fixture(3);
    if (stage === "dispatch") value.transport.createIssue.mockRejectedValue(new Error("isolated dispatch failure"));
    else value.transport.verifyClassifications.mockResolvedValue(false);
    const result = await value.execute();
    expect(result.candidates.map(candidate => candidate.disposition)).toEqual(["refused", "interrupted", "interrupted"]);
    expect(result.status).toBe("infrastructure");
    expect(fileFindingExitCode(result)).toBe(4);
    expect(value.transport.createIssue).toHaveBeenCalledTimes(2);
    expect(value.transport.preflightClassifications).toHaveBeenCalledTimes(2);
  });

  it("resets consecutive failures only after a fresh dispatch completes", async () => {
    const value = fixture(5);
    value.transport.createIssue.mockRejectedValueOnce(new Error("first failure"))
      .mockResolvedValueOnce({ issueNumber: 1901, issueId: "I_1901" })
      .mockRejectedValue(new Error("later failure"));
    const result = await value.execute();
    expect(result.candidates.map(candidate => candidate.disposition)).toEqual(["refused", "filed", "refused", "interrupted", "interrupted"]);
    expect(value.transport.createIssue).toHaveBeenCalledTimes(4);
    expect(fileFindingExitCode(result)).toBe(4);
  });

  it("reports a session-wide preflight exception as infrastructure", async () => {
    const value = fixture(3);
    value.transport.preflightClassifications.mockRejectedValue(Object.assign(new Error("HTTP 429"), { status: 429 }));
    const path = join(value.root, "result.json");
    expect(await runFileFindingCommand({ ...value.input, argv: [...value.input.argv, "--execute", `--result=${path}`], operatorToken: "fixture-token" })).toBe(4);
    const result = JSON.parse(readFileSync(path, "utf8"));
    expect(result.candidates.map((candidate: { disposition: string }) => candidate.disposition)).toEqual(Array(3).fill("interrupted"));
    expect(value.transport.preflightClassifications).toHaveBeenCalledOnce();
    expect(value.transport.createIssue).not.toHaveBeenCalled();
  });

  it("reports replay, hold with competitors, and filed in a mixed envelope", async () => {
    const value = fixture(3);
    seedComplete({ ...value.envelope, candidates: [value.envelope.candidates[0]] });
    const marker = markerBlock(value.envelope, value.envelope.candidates[1]);
    value.publishCensus(stackSnapshot(value.envelope, censusPass([
      censusIssue({ number: 7, body: marker }), censusIssue({ number: 8, databaseId: 8, nodeId: "I_8", body: marker }),
    ])));
    const result = await value.execute();
    expect(result.candidates.map(candidate => candidate.disposition)).toEqual(["replay", "hold", "filed"]);
    expect(result.candidates[1]).toMatchObject({ competingIssues: [7, 8] });
    expect(value.transport.createIssue).toHaveBeenCalledOnce();
    expect(value.transport.appendEvidenceComment).not.toHaveBeenCalled();
    expect(fileFindingExitCode(result)).toBe(1);
  });

  it.each([
    { marker: false, close: true }, { marker: true, close: true }, { marker: false, close: false },
  ])("holds an unapproved append before any write, including sibling recovery ($marker / $close)", async ({ marker, close }) => {
    const value = fixture(2);
    const outcome = value.envelope.candidates[0];
    const body = markerBlock(value.envelope, outcome);
    value.publishCensus(stackSnapshot(value.envelope, censusPass([
      censusIssue({ number: 7, body: marker ? markerBlock(value.envelope, outcome, "d".repeat(64)) : "" }),
    ])));
    // Pin the approval boundary's append-then-close input even without marker evidence.
    // A prior unverified append must not be recovered by the sibling's apply call.
    const path = resolveJournalPath("example-org/example-repo");
    const claim = acquireExecutionClaim(path, { mode: "execute" });
    try {
      for (const event of ["intent", "created"] as const) claim.withOwnership(() => appendJournal(path, executionEvent({
        event, now: NOW, decisionContentSha256: "d".repeat(64),
        write: { sourceFingerprint: outcome.sourceFingerprint, repository: "example-org/example-repo", action: "append_evidence",
          actions: close ? ["append_evidence", "close_issue"] : ["append_evidence"], canonicalIssueNumber: 7, issue: null, evidenceComment: body,
          closeIssue: close ? { targetIssueNumber: 7, before: "OPEN", after: "CLOSED", evidenceIds: ["evidence-current"] } : null,
          classifications: [{ fieldName: "Type", value: "Task" }], suggestedHorizon: null },
        issueNumber: 7, commentId: event === "created" ? "C_unverified" : null,
      })));
    } finally { claim.release(); }
    const shadow = intakeShadow.runIntakeShadow;
    vi.spyOn(intakeShadow, "runIntakeShadow").mockImplementation(input => {
      const result = shadow(input);
      const report = { ...result.report, candidates: result.report.candidates.map((candidate, index) => index === 0 ? {
        ...candidate, draft: { ...candidate.draft!, intendedAction: "append_evidence" as const,
          intendedActions: close ? ["append_evidence", "close_issue"] as const : ["append_evidence"] as const, canonicalIssueNumber: 7,
          closeIssue: close ? { targetIssueNumber: 7, before: "OPEN" as const, after: "CLOSED" as const, evidenceIds: ["evidence-current"] } : null,
          closeBasis: "existence demonstrated", evidenceComment: body },
      } : candidate) };
      writeFileSync(result.outputPath, JSON.stringify(report));
      return { ...result, report };
    });
    const apply = vi.spyOn(intakeApply, "runIntakeApplyCli");
    allowCapture(value);
    const result = await value.execute();
    expect(result.candidates[0]).toMatchObject({ disposition: "hold", suggestion: { kind: close ? "close" : "append", targetIssueNumber: 7 } });
    expect(result.candidates[1].disposition).toBe("filed");
    expect(apply).toHaveBeenCalledOnce();
    expect(value.transport.createIssue).toHaveBeenCalledOnce();
    expect(value.transport.appendEvidenceComment).not.toHaveBeenCalled();
    expect(value.transport.closeIssue).not.toHaveBeenCalled();
    expect(value.transport.applyClassification.mock.calls.every(call => (call as unknown[])[1] === 1901)).toBe(true);
    expect(readJournal(path).records.filter(row => (row as { sourceFingerprint?: string }).sourceFingerprint === outcome.sourceFingerprint)).toHaveLength(2);
  });

  it("keeps the first create filed when expiry reassessment fails and interrupts the rest", async () => {
    const value = fixture(3);
    const now = vi.fn(() => NOW);
    const runners = captureRunners(value, now);
    value.transport.createIssue.mockImplementation(async () => {
      now.mockReturnValue(new Date("2026-08-20T13:00:01.000Z"));
      return { issueNumber: 1901, issueId: "I_1901" };
    });
    const assessor = value.caller.getMockImplementation()!;
    value.caller.mockImplementation(async call => {
      if (value.caller.mock.calls.length > 1) throw new Error("seat unavailable during reassessment");
      return assessor(call);
    });
    const resultPath = join(value.root, "interrupted-result.json");
    expect(await runFileFindingCommand({ ...value.input, ...runners, now,
      argv: [...value.input.argv, "--execute", `--result=${resultPath}`], operatorToken: "fixture-token" })).toBe(4);
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as FileFindingResult;
    expect(result.candidates.map(candidate => candidate.disposition)).toEqual(["filed", "interrupted", "interrupted"]);
    expect(result.candidates[0].issueNumber).toBe(1901);
    expect(value.caller).toHaveBeenCalledTimes(2);
    expect((value.caller.mock.calls[1][0].evidence.candidateEnvelope as OutcomeEnvelope).candidates).toEqual(value.envelope.candidates.slice(1));
    expect(value.transport.createIssue).toHaveBeenCalledOnce();
    expect(runners.runIntakePreflightCli).toHaveBeenCalledOnce();
  });

  it("reassesses only the remaining candidates after the first create when the census expires", async () => {
    const value = fixture(3);
    const now = vi.fn(() => NOW);
    const runners = captureRunners(value, now);
    const create = value.transport.createIssue.getMockImplementation()!;
    value.transport.createIssue.mockImplementation(async () => {
      now.mockReturnValue(new Date("2026-08-20T13:00:01.000Z"));
      return create();
    });
    const result = await runFileFindingCli({ ...value.input, ...runners, now,
      argv: [...value.input.argv, "--execute"], operatorToken: "fixture-token" });
    expect(result.candidates.map(candidate => candidate.disposition)).toEqual(["filed", "filed", "filed"]);
    expect(result.candidates.map(candidate => candidate.issueNumber)).toEqual([1901, 1902, 1903]);
    expect(value.caller).toHaveBeenCalledTimes(2);
    expect((value.caller.mock.calls[1][0].evidence.candidateEnvelope as OutcomeEnvelope).candidates).toEqual(value.envelope.candidates.slice(1));
    expect(value.transport.createIssue).toHaveBeenCalledTimes(3);
    expect(runners.runIntakePreflightCli).toHaveBeenCalledOnce();
  });

  it("retains the five-candidate admission budget before any pipeline work", async () => {
    const value = fixture(6);
    await expect(value.execute()).rejects.toThrow("at most five active candidates per envelope");
    expect(value.caller).not.toHaveBeenCalled();
    expect(existsSync(join(value.root, FILE_FINDING_ROOT, "runs"))).toBe(false);
    value.untouchedTransport();
  });

  it("dispatches two different emissions as two comments and replays either emission", async () => {
    const value = fixture();
    const emissions = [1, 2].map(index => createOutcomeEnvelope({ ...value.envelope,
      candidates: value.envelope.candidates.map(({ sourceFingerprint: _fingerprint, emissionContentSha256: _emission, ...candidate }) => ({
        ...candidate, evidence: [...candidate.evidence, { ...candidate.evidence[0], id: `new-evidence-${index}` }],
      })),
    }));
    value.publishCensus(stackSnapshot(value.envelope, censusPass([
      censusIssue({ number: 7, body: markerBlock(value.envelope, value.envelope.candidates[0]) }),
    ])));
    value.transport.appendEvidenceComment.mockResolvedValueOnce({ commentId: "C_first" }).mockResolvedValueOnce({ commentId: "C_second" });
    allowCapture(value);
    for (const envelope of emissions) {
      value.write("finding.roadmap-outcomes.json", JSON.stringify(envelope));
      expect((await value.execute()).candidates[0]).toMatchObject({ disposition: "appended", issueNumber: 7 });
    }
    expect(value.transport.appendEvidenceComment).toHaveBeenCalledTimes(2);
    expect(value.transport.createIssue).not.toHaveBeenCalled();
    expect(value.transport.closeIssue).not.toHaveBeenCalled();
    value.caller.mockClear();
    value.openTransport.mockClear();
    for (const method of Object.values(value.transport)) method.mockClear();
    unlinkSync(value.censusPath);
    for (const envelope of emissions) {
      value.write("finding.roadmap-outcomes.json", JSON.stringify(envelope));
      expect((await value.execute()).candidates[0]).toMatchObject({ disposition: "replay", issueNumber: 7 });
    }
    expect(value.caller).not.toHaveBeenCalled();
    value.untouchedTransport();
  });

  it.each([
    { submitted: 0, otherState: "classification_failed" },
    { submitted: 1, otherState: "classification_failed" },
    { submitted: 0, otherState: "abandoned" },
  ] as const)("binds marker replay to submitted emission $submitted with sibling $otherState", async ({ submitted, otherState }) => {
    const value = fixture();
    const emissions = [0, 1].map(index => createOutcomeEnvelope({ ...value.envelope,
      candidates: value.envelope.candidates.map(({ sourceFingerprint: _fingerprint, emissionContentSha256: _emission, ...candidate }) => ({
        ...candidate, evidence: [...candidate.evidence, { ...candidate.evidence[0], id: `replay-evidence-${index}` }],
      })),
    }));
    const path = resolveJournalPath("example-org/example-repo");
    const claim = acquireExecutionClaim(path, { mode: "execute" });
    try {
      for (const [index, envelope] of emissions.entries()) {
        const write: intakeApply.IntakeApplyResult["writes"][number] = {
          sourceFingerprint: envelope.candidates[0].sourceFingerprint, repository: "example-org/example-repo",
          action: "append_evidence", actions: ["append_evidence"], canonicalIssueNumber: 7, issue: null,
          evidenceComment: markerBlock(envelope, envelope.candidates[0]), closeIssue: null,
          classifications: [{ fieldName: "Type", value: index === 0 ? "Task" : "Bug" }], suggestedHorizon: null,
        };
        const pending = executionEvent({ event: "intent", now: NOW, decisionContentSha256: "d".repeat(64), write });
        claim.withOwnership(() => appendJournal(path, pending));
        if (index === 1 && otherState === "abandoned") {
          claim.withOwnership(() => appendJournal(path, { ...pending, event: "abandoned",
            abandonment: { reason: "Stop sibling", operator: "test", priorState: "intent_unknown",
              priorEventRowNumber: readJournal(path).records.length, at: NOW.toISOString() } }));
        } else {
          for (const event of ["created", index === 0 ? "complete" : "classification_failed"] as const) {
            claim.withOwnership(() => appendJournal(path, executionEvent({ event, now: NOW, decisionContentSha256: "d".repeat(64),
              write, issueNumber: 7, commentId: `C_${index}`, ...(event === "classification_failed" ? { error: "Read-back failed" } : {}) })));
          }
        }
      }
    } finally { claim.release(); }
    const before = readJournal(path).records;
    const envelope = emissions[submitted];
    value.write("finding.roadmap-outcomes.json", JSON.stringify(envelope));
    value.publishCensus(stackSnapshot(envelope, censusPass([
      censusIssue({ number: 7, body: markerBlock(envelope, envelope.candidates[0]) }),
    ])));
    const result = await value.execute();
    expect(result.candidates[0]).toMatchObject(submitted === 0
      ? { disposition: "replay", reason: "already_filed", issueNumber: 7 }
      : { disposition: "appended", issueNumber: 7 });
    expect(fileFindingExitCode(result)).toBe(0);
    expect(readJournal(path).records.slice(0, before.length)).toEqual(before);
    if (submitted === 0) {
      value.untouchedTransport();
      expect(readJournal(path).records).toEqual(before);
    } else {
      expect(value.transport.applyClassification).toHaveBeenCalledExactlyOnceWith("example-org/example-repo", 7,
        { fieldName: "Type", value: "Bug" }, expect.any(Function));
      expect(value.transport.verifyClassifications).toHaveBeenCalledOnce();
      expect(readJournal(path).records.slice(before.length)).toEqual([expect.objectContaining({ event: "complete",
        emissionContentSha256: envelope.candidates[0].emissionContentSha256, commentId: "C_1" })]);
    }
    expect(value.transport.createIssue).not.toHaveBeenCalled();
    expect(value.transport.appendEvidenceComment).not.toHaveBeenCalled();
  });

  it.each(["snapshot", "bundle"])("checks the qualified explicit %s identity, not only the repository name", async format => {
    const value = fixture();
    const changed = { ...value.census, repository: { ...value.census.repository, databaseId: 999 } };
    const { candidateSha256, canonicalSnapshotV2Sha256, repository, censusContentSha256, issues, markerIndex, markerIncidents, projectObservation, receipts } = changed;
    changed.contentSha256 = canonicalJsonSha256({ candidateSha256, canonicalSnapshotV2Sha256, repository, censusContentSha256, issues, markerIndex, markerIncidents, projectObservation, receipts });
    const supplied = value.write("supplied-census.json", JSON.stringify(format === "snapshot" ? changed : censusBundle(parseIntakeSnapshotV1(changed), NOW)));
    await expect(runFileFindingCli({ ...value.input, argv: [...value.input.argv, `--census=${supplied}`, "--execute"],
      operatorToken: "fixture-token" })).rejects.toThrow("census_repository_mismatch:");
    value.untouchedTransport();
  });

  it.each(["create_issue", "append_evidence"] as const)("recovers marker replay with an unfinished %s classification", async action => {
    const value = fixture();
    if (action === "append_evidence") value.publishCensus(stackSnapshot(value.envelope,
      censusPass([censusIssue({ body: markerBlock(value.envelope, value.envelope.candidates[0], "d".repeat(64)) })])));
    value.transport.verifyClassifications.mockResolvedValueOnce(false);
    const first = await value.execute();
    expect(first.candidates[0].disposition).toBe("refused");
    const issueNumber = action === "create_issue" ? 1901 : 7;
    value.publishCensus(stackSnapshot(value.envelope, censusPass([
      censusIssue({ number: issueNumber, body: markerBlock(value.envelope, value.envelope.candidates[0]) }),
    ])));
    for (const method of Object.values(value.transport)) method.mockClear();
    const apply = vi.spyOn(intakeApply, "runIntakeApplyCli");
    const result = await value.execute();
    expect(apply).toHaveBeenCalledOnce();
    expect(result.candidates[0]).toMatchObject({ disposition: action === "create_issue" ? "filed" : "appended", issueNumber });
    expect(value.transport.verifyClassifications).toHaveBeenCalledOnce();
    expect(value.transport.createIssue).not.toHaveBeenCalled();
    expect(value.transport.appendEvidenceComment).not.toHaveBeenCalled();
    expect(readJournal(resolveJournalPath("example-org/example-repo")).records.at(-1)).toMatchObject({ event: "complete", action });
  });

  it.each(["unresolved", "abandoned", "malformed", "conflict"] as const)("does not accept marker replay over %s append history", async kind => {
    const value = fixture();
    const candidate = value.envelope.candidates[0];
    const marker = markerBlock(value.envelope, candidate);
    value.publishCensus(stackSnapshot(value.envelope, censusPass([censusIssue({ body: marker })])));
    const path = resolveJournalPath("example-org/example-repo");
    const claim = acquireExecutionClaim(path, { mode: "execute" });
    try {
      const pending = executionEvent({ event: "intent", now: NOW, decisionContentSha256: "d".repeat(64),
        write: { sourceFingerprint: candidate.sourceFingerprint, repository: "example-org/example-repo", action: "append_evidence",
          actions: ["append_evidence"], canonicalIssueNumber: 7, issue: null, evidenceComment: marker,
          closeIssue: null, classifications: [], suggestedHorizon: null } });
      claim.withOwnership(() => appendJournal(path, pending));
      if (kind === "abandoned") claim.withOwnership(() => appendJournal(path, { ...pending, event: "abandoned",
        abandonment: { reason: "Stop append", operator: "test", priorState: "intent_unknown", priorEventRowNumber: 1, at: NOW.toISOString() } }));
      if (kind === "malformed") claim.withOwnership(() => appendJournal(path, { ...pending, event: "invalid" }));
      if (kind === "conflict") claim.withOwnership(() => appendJournal(path, { ...pending, issueNumber: 8 }));
    } finally { claim.release(); }
    allowCapture(value);
    const result = await value.execute();
    expect(result.candidates[0].disposition).toBe("refused");
    expect(fileFindingExitCode(result)).toBe(1);
    value.untouchedTransport();
  });

  it("does not shortcut a complete create past unfinished append safety history", async () => {
    const value = fixture();
    seedComplete(value.envelope);
    const candidate = value.envelope.candidates[0];
    const path = resolveJournalPath("example-org/example-repo");
    const claim = acquireExecutionClaim(path, { mode: "execute" });
    try {
      claim.withOwnership(() => appendJournal(path, executionEvent({ event: "intent", now: NOW, decisionContentSha256: "d".repeat(64),
        write: { sourceFingerprint: candidate.sourceFingerprint, repository: "example-org/example-repo", action: "append_evidence",
          actions: ["append_evidence"], canonicalIssueNumber: 1901, issue: null,
          evidenceComment: markerBlock(value.envelope, candidate, "d".repeat(64)), closeIssue: null, classifications: [], suggestedHorizon: null } })));
    } finally { claim.release(); }
    value.publishCensus(stackSnapshot(value.envelope, censusPass([
      censusIssue({ number: 1901, body: markerBlock(value.envelope, candidate) }),
    ])));
    expect((await value.execute()).candidates[0].disposition).toBe("refused");
    value.untouchedTransport();
  });

  it.each([true, false])("replays a consumed marker or appends new evidence (same emission=%s)", async (sameEmission) => {
    const value = fixture();
    const marker = markerBlock(value.envelope, value.envelope.candidates[0],
      sameEmission ? value.envelope.candidates[0].emissionContentSha256 : "d".repeat(64));
    value.publishCensus(stackSnapshot(value.envelope, censusPass([censusIssue({ body: marker })])));
    const result = await value.execute();
    expect(result.candidates[0].disposition).toBe(sameEmission ? "replay" : "appended");
    expect(existsSync(join(dirname(resolveJournalPath("example-org/example-repo")), "execution.lock"))).toBe(false);
    if (sameEmission) value.untouchedTransport();
    else {
      expect(value.transport.appendEvidenceComment).toHaveBeenCalledOnce();
      expect(result.appends).toEqual({ marker: [result.candidates[0].issueNumber], modelJudged: [] });
    }
    expect(value.transport.createIssue).not.toHaveBeenCalled();
    expect(value.transport.closeIssue).not.toHaveBeenCalled();
  });

  it("keeps model overlap judgment as an annotation and still files", async () => {
    const value = fixture();
    const implementation = value.caller.getMockImplementation()!;
    value.caller.mockImplementation(async (call) => {
      const result = await implementation(call);
      const assessment = result.output as ReturnType<typeof evidenceAssessment>;
      return { ...result, output: { ...assessment, candidates: assessment.candidates.map((candidate) => ({
        ...candidate, match: { ...candidate.match, result: "plausible_overlap", competingIssueNumbers: [7],
          rationale: "Model suspects overlap; deterministic identity is absent." },
      })) } };
    });
    const result = await value.execute();
    expect(result.candidates[0].disposition).toBe("filed");
    expect(value.transport.createIssue).toHaveBeenCalledOnce();
    expect(result.apply!.writes[0].issue?.body).toContain("Model suspects overlap");
    expect(result.candidates[0].suggestion).toEqual({ kind: "append", targetIssueNumber: 7 });
    expect(value.transport.appendEvidenceComment).not.toHaveBeenCalled();
    expect(value.transport.closeIssue).not.toHaveBeenCalled();
  });
});
