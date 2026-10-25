import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { probeExistenceAtSha, runExistenceProbeCli } from "./github-issue-roadmap-existence-probe";
import { IntakeExecutionBreaker, indexHistory, resolveDurableState, resolveSubmittedReplayState, runIntakeApplyCli, type IntakeApplyResult, type OperatorIntakeApprovalTransport } from "./github-issue-roadmap-intake-apply";
import { buildIntakeApprovalPlan } from "./github-issue-roadmap-intake-approve";
import { collectIntakeIssue, collectIntakeIssueIndex, detectIntakeCensusDrift, runIntakePreflightCli } from "./github-issue-roadmap-intake-preflight";
import { createGhRunner, readGraphqlWithMetadata, runPreflightCli } from "./github-issue-roadmap-preflight";
import { assertClosingBoardFingerprint, parseBoardFingerprint, readBoardFingerprint } from "./lib/github-issue-roadmap/board-fingerprint";
import { assertPathInsideRepository, assertRoadmapArtifactOutputPath } from "./lib/github-issue-roadmap/artifact-io";
import { AssessmentEvidenceViewCapError, VIEW_CAP_EXCEEDED_CODE } from "./lib/github-issue-roadmap/assessment-evidence-view";
import { canonicalJsonSha256, prettyCanonicalJson } from "./lib/github-issue-roadmap/canonical-json";
import { readActionQualification, withActionQualificationContext, currentAssessmentStackHash, ACTION_QUALIFICATION_COMMAND } from "./lib/github-issue-roadmap/action-qualification";
import { loadActionQualificationContext, resolveActionJudgementRoot } from "./github-issue-roadmap-judge";
import { INTAKE_OBSERVATION_DIRECTORY, INTAKE_OBSERVATION_SCHEMA_V2, readIntakeJournalRecord } from "./lib/github-issue-roadmap/intake-observation";
import { bankActionJudgementMaterial, type ActionLabel } from "./lib/github-issue-roadmap/judgement-record";
import { runCredentialCleanGit } from "./lib/github-issue-roadmap/credential-clean-git";
import { criteriaAuthorship, dispositionHistory, dispositionHistoryRef, effectiveOutcomeCandidates } from "./lib/github-issue-roadmap/disposition-history";
import type { CriteriaAuthorship, CriteriaAuthorshipLookup } from "./lib/github-issue-roadmap/disposition-selection";
import { assertDeliveryInboxOutsideWorktrees, deliveryEnvelope, localDeliveryGit, readFindingDelivery, verifyFindingDelivery } from "./lib/github-issue-roadmap/finding-delivery";
import { createGitHubIntakeApprovalTransport, hasGitHubRequestStatus } from "./lib/github-issue-roadmap/github-intake-approval-transport";
import { inWorkingDirectory } from "./lib/github-issue-roadmap/in-working-directory";
import { assertEffectiveIntakeEnvelopeBudgets, assertIntakeEnvelopeByteBudgets, parseAssessmentStackDescriptor } from "./lib/github-issue-roadmap/intake-assessment";
import { ASSESSMENT_SEAT_INPUT_CHARACTER_CAP, evaluateIntakeAssessmentBundle, REPO_ASSESSMENT_PROMPT, REPO_STACK_DESCRIPTOR, SEAT_INPUT_CAP_EXCEEDED_CODE, type IntakeAssessmentModelCaller } from "./lib/github-issue-roadmap/intake-assessment-evaluator";
import { acquireExecutionClaim, ExecutionClaimRefusedError, readJournal, resolveJournalPath, type ExecutionClaim } from "./lib/github-issue-roadmap/intake-execution-journal";
import { buildRunEvidence } from "./lib/github-issue-roadmap/intake-run-evidence";
import { assertIntakeSnapshotFreshForShadow, runIntakeShadow, SHADOW_REQUIRED_RECEIPT_DOMAINS, SHADOW_SNAPSHOT_MAXIMUM_AGE_MS } from "./lib/github-issue-roadmap/intake-shadow";
import { buildIntakeSnapshot, parseIntakeSnapshotV1, type IntakeSnapshotV1, type IntakeCensusPass } from "./lib/github-issue-roadmap/intake-snapshot";
import { authorOperatorAssessmentRequestBundle } from "./lib/github-issue-roadmap/operator-assessment-request-bundle";
import { outcomeSourceContentMatchesSha256, outcomeSourceContentSha256, parseOutcomeEnvelope, type OutcomeEnvelope } from "./lib/github-issue-roadmap/outcome-candidate";
import { AMBIENT_GITHUB_CREDENTIAL_NAMES, createReadOnlyGhRunner, type GhRunner } from "./lib/github-issue-roadmap/read-only-github-reader";
import { assertSharedCensusPath, parseSharedCensusBundle, publishSharedCensus, readSharedCensus, type SharedCensusBundle, type SerializedIntakeIssueIndex } from "./lib/github-issue-roadmap/shared-census-store";
import { parseCanonicalSnapshotV2 } from "./lib/github-issue-roadmap/snapshot-v2";

export const FILE_FINDING_ROOT = "artifacts/github-issue-roadmap/file-findings";

type GitRunner = typeof runCredentialCleanGit;

/** The bundle's journal anchor: record count plus the last record's hash ("empty" for none). */
export function journalPositionOf(journal: ReturnType<typeof readJournal>): SharedCensusBundle["journalPosition"] {
  return { recordCount: journal.records.length,
    lastRecordSha256: journal.records.length === 0 ? "empty" : canonicalJsonSha256(journal.records.at(-1)) };
}

/** Classify whole operations, retaining the touched set for later targeted refresh. */
export function checkCensusJournal(position: SharedCensusBundle["journalPosition"], journal: ReturnType<typeof readJournal>, repository: string): {
  readonly eligible: boolean; readonly touchedIssueNumbers: readonly number[]; readonly createdIssueNumbers: readonly number[];
} {
  const history = indexHistory(journal.records, journal.tail);
  if (journal.tail !== null || history.malformed.length > 0 || history.conflicts.length > 0 ||
      journal.records.length < position.recordCount ||
      (position.recordCount === 0 ? position.lastRecordSha256 !== "empty"
        : canonicalJsonSha256(journal.records[position.recordCount - 1]) !== position.lastRecordSha256)) {
    return { eligible: false, touchedIssueNumbers: [], createdIssueNumbers: [] };
  }
  const operations = new Set([...history.staged.values(), ...[...history.legacy.values()].flat()]);
  const touched = new Set<number>();
  const created = new Set<number>();
  let eligible = true;
  for (const operation of operations) {
    if (!operation.history.some(row => row.rowNumber > position.recordCount)) continue;
    // Resolve whole operations, including intents before the anchor. Unknown or
    // ambiguous identities still force a capture, even alongside resolved writes.
    if (operation.repository?.toLowerCase() !== repository.toLowerCase() || operation.sourceFingerprints.length !== 1) eligible = false;
    for (const sourceFingerprint of operation.sourceFingerprints) {
      const state = resolveDurableState(history, { repository, sourceFingerprint, action: operation.action,
        emissionContentSha256: operation.event?.event === "complete" ? operation.event.emissionContentSha256 : undefined }, true);
      if (state.kind !== "complete" || operation.result.issueNumber === null) eligible = false;
      for (const effect of state.operations) {
        if (effect.history.some(row => row.rowNumber > position.recordCount) && effect.result.issueNumber !== null) {
          touched.add(effect.result.issueNumber);
          if (effect.action === "create_issue") created.add(effect.result.issueNumber);
        }
      }
    }
  }
  return { eligible, touchedIssueNumbers: [...touched].sort((a, b) => a - b), createdIssueNumbers: [...created].sort((a, b) => a - b) };
}

/** Call immediately before each apply. Classification age alone never recaptures a census. */
export function censusNeedsRefreshBeforeApply(census: IntakeSnapshotV1, nextApplyAt: Date): boolean {
  return census.receipts.some(receipt => SHADOW_REQUIRED_RECEIPT_DOMAINS.includes(receipt.domain)
    && nextApplyAt.getTime() - Date.parse(receipt.fetchedAt) > SHADOW_SNAPSHOT_MAXIMUM_AGE_MS);
}

/** Scope canonical runner creation and capture to the read token (or stored gh
 * login), restoring the caller's env after the synchronous call. */
function withCensusCredentials<T>(run: () => T): T {
  const names = AMBIENT_GITHUB_CREDENTIAL_NAMES;
  const saved = names.map(name => process.env[name]);
  try {
    for (const name of names) delete process.env[name];
    if (process.env.GH_READ_ONLY_TOKEN?.trim()) process.env.GH_TOKEN = process.env.GH_READ_ONLY_TOKEN;
    return run();
  } finally {
    names.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name];
      else process.env[name] = saved[index];
    });
  }
}

/** A read-only reader with ambient mutation-capable credentials removed; built per use so it sees the current env. */
function createCensusReader() {
  return createReadOnlyGhRunner({ environment: {
    ...process.env, ...Object.fromEntries(AMBIENT_GITHUB_CREDENTIAL_NAMES.map(name => [name, undefined])),
  } });
}

function assertFresh(census: IntakeSnapshotV1, now: Date): void {
  try { assertIntakeSnapshotFreshForShadow(census, now); }
  catch (error) {
    throw new Error(`census_stale: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** Read-only blob comparison also detects skip-worktree/assume-unchanged files.
 * Accept CRLF checkouts of LF sources without depending on Git's clean config. */
function assertCommittedSources(repoRoot: string, envelope: OutcomeEnvelope, runGit: GitRunner): string {
  let head: string;
  try {
    head = runGit(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("Invalid HEAD commit.");
  } catch (error) {
    throw new Error("source_not_committed: a readable HEAD commit is required.", { cause: error });
  }
  const citations = envelope.candidates.flatMap((candidate) => [...candidate.evidence, ...candidate.provenance]);
  const locators = new Set([envelope.artifact.sourceLocator, ...citations.map((citation) => citation.sourceLocator)]);
  for (const locator of locators) {
    try {
      const path = assertPathInsideRepository(locator, repoRoot, "Finding source");
      const committed = runGit(repoRoot, ["rev-parse", "--verify", `${head}:${locator}`]);
      if (!/^[a-f0-9]{40,64}$/.test(committed)) throw new Error("Invalid committed blob.");
      // Base64 preserves exact bytes; the clean runner's default 1 MiB output
      // limit bounds the blob read and an oversized source fails closed.
      const committedBytes = Buffer.from(runGit(repoRoot, ["cat-file", "blob", committed], { output: "base64" }), "base64");
      const bytes = readFileSync(path);
      if (!outcomeSourceContentMatchesSha256(bytes, outcomeSourceContentSha256(committedBytes))) {
        throw new Error("Source is not the committed blob.");
      }
      if (citations.some((citation) => citation.sourceLocator === locator &&
          !outcomeSourceContentMatchesSha256(bytes, citation.contentSha256))) {
        throw new Error("Source differs from its cited content hash.");
      }
    } catch (error) {
      throw new Error(`source_not_committed: ${locator} must match committed, cited content.`, { cause: error });
    }
  }
  if (runGit(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]) !== head) {
    throw new Error("source_not_committed: HEAD changed while verifying the finding.");
  }
  return head;
}

// The same candidate rebinding as the drain: preserve all census material and receipts.
function rebindCensus(census: IntakeSnapshotV1, envelope: OutcomeEnvelope): IntakeSnapshotV1 {
  const candidateSha256 = canonicalJsonSha256(envelope);
  const core = {
    candidateSha256, canonicalSnapshotV2Sha256: census.canonicalSnapshotV2Sha256,
    repository: census.repository, censusContentSha256: census.censusContentSha256,
    issues: census.issues, markerIndex: census.markerIndex, markerIncidents: census.markerIncidents,
    projectObservation: census.projectObservation, receipts: census.receipts,
  };
  return parseIntakeSnapshotV1({ ...census, candidateSha256, contentSha256: canonicalJsonSha256(core) });
}

function argumentsMap(argv: readonly string[]) {
  const values = new Map<string, string>();
  let execute = false;
  let freshCensus = false;
  for (const argument of argv) {
    if (argument === "--execute" && !execute) { execute = true; continue; }
    if (argument === "--fresh-census" && !freshCensus) { freshCensus = true; continue; }
    const match = /^--(candidate|delivery|repository|census|result|wait-minutes)=(.+)$/.exec(argument);
    if (match === null || values.has(match[1])) throw new Error(`Unsupported or duplicate argument: ${argument}`);
    values.set(match[1], match[2]);
  }
  if (values.has("candidate") === values.has("delivery") || !/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(values.get("repository") ?? "")) {
    throw new Error("file-finding requires exactly one of --candidate=PATH or --delivery=INBOX_RECORD, plus --repository=Owner/repo [--census=PATH | --fresh-census] [--result=PATH] [--wait-minutes=N] [--execute].");
  }
  const waitValue = values.get("wait-minutes") ?? "45";
  const waitMinutes = Number(waitValue);
  if (!/^\d+$/.test(waitValue) || !Number.isSafeInteger(waitMinutes)) throw new Error("--wait-minutes must be a non-negative integer.");
  if (freshCensus && values.has("census")) throw new Error("--fresh-census cannot be combined with --census.");
  return { candidate: values.get("candidate"), delivery: values.get("delivery"), repository: values.get("repository")!, census: values.get("census"), result: values.get("result"), waitMinutes, execute, freshCensus };
}

export type FileFindingDisposition = "filed" | "replay" | "appended" | "closed" | "hold" | "pending" | "refused" | "interrupted" | "dry-run" | "dispositioned";

export type FileFindingCandidateResult = {
  readonly sourceFingerprint: string;
  readonly stableOutcomeId: string;
  readonly reason: string;
  readonly issueNumber?: number;
  readonly fixingCommand?: string;
  readonly suggestion?: { readonly kind: "append" | "close"; readonly targetIssueNumber: number };
  readonly suggestions?: readonly { readonly kind: "append" | "close"; readonly targetIssueNumber: number }[];
  readonly appendKind?: "marker" | "model_overlap";
  readonly judgementObservationId?: string;
  readonly actionQualification?: readonly { readonly kind: string; readonly reason: string; readonly fixingCommand: string }[];
} & (
  | { readonly disposition: "filed" | "replay" | "appended" | "closed"; readonly issueNumber: number }
  | { readonly disposition: "hold"; readonly competingIssues: readonly number[] }
  | { readonly disposition: "refused"; readonly fixingCommand: string }
  | { readonly disposition: "pending" | "interrupted" | "dispositioned" }
  | { readonly disposition: "dry-run"; readonly projectedAction: "create_issue" | "append_evidence" | "append_evidence_overlap" | "close_issue" | "close_issue_existence" | null }
);

export interface FileFindingMetrics {
  /** Capture wins if a reused census later needs a pre-apply refresh. */
  censusMode?: "reuse" | "capture";
  /** Cumulative elapsed milliseconds; stages that were not reached are omitted. */
  readonly durationsMs: Partial<Record<"claimWait" | "census" | "assessment" | "existenceProbe" | "apply", number>>;
  /** Runner invocations, including failed reads; apply's write transport is excluded. */
  readonly githubReads: { canonical: number; intake: number; [stage: string]: number };
}

export interface FileFindingResult {
  readonly schemaVersion: 1;
  readonly status: "completed" | "dry-run" | "no-op" | "busy" | "infrastructure";
  readonly runRoot: string;
  /** Requested configuration only, never the provider's served identity. */
  readonly requestedAssessor: { readonly provider: string; readonly model: string; readonly prompt: string; readonly release: string };
  readonly candidates: readonly FileFindingCandidateResult[];
  readonly infrastructureNotes?: readonly string[];
  readonly appends?: { readonly marker: readonly number[]; readonly modelJudged: readonly number[] };
  /** Diagnostics for the last apply invocation; dispositions cover the whole envelope. */
  readonly apply?: IntakeApplyResult;
  readonly metrics?: FileFindingMetrics;
}

/** KTD10: first match wins. Exit 3 is reserved for legacy children only. */
export function fileFindingExitCode(result: FileFindingResult): 0 | 1 | 2 | 4 | 5 {
  if (result.status === "busy") return 5;
  if (result.status === "infrastructure" || result.candidates.some(candidate => candidate.disposition === "interrupted")) return 4;
  if (result.candidates.some(candidate => candidate.disposition === "hold" || candidate.disposition === "refused")) return 1;
  if (result.candidates.some(candidate => candidate.disposition === "pending")) return 2;
  return 0;
}

function requestedAssessor(repoRoot: string): FileFindingResult["requestedAssessor"] {
  const descriptor = parseAssessmentStackDescriptor(JSON.parse(readFileSync(join(repoRoot, REPO_STACK_DESCRIPTOR), "utf8")),
    readFileSync(join(repoRoot, REPO_ASSESSMENT_PROMPT), "utf8"), REPO_ASSESSMENT_PROMPT);
  return { provider: descriptor.provider, model: descriptor.model, prompt: descriptor.promptSha256, release: descriptor.calibrationRelease };
}

function infrastructureFailureReason(reason: string): string | undefined {
  // Apply adds this exact context when a classification read-back throws.
  return /^(?:Classification read-back unavailable: )?((?:assessor_unavailable|credential_unreadable):[\s\S]*)$/.exec(reason)?.[1];
}

/** The fallback is deliberately an inspection action, never an automatic redispatch:
 * upstream apply refusals can describe an unresolved primary effect in prose. */
export function fileFindingFixingCommand(reason: string, args: ReturnType<typeof argumentsMap>, runRoot: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const wrapper = `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\run-github-issue-roadmap-file-finding.ps1 ${args.delivery === undefined
    ? `-Candidate ${quote(args.candidate!)}` : `-Delivery ${quote(args.delivery)}`} -Repository ${quote(args.repository)} -Execute`;
  switch (reason.split(":", 1)[0]) {
    case "census_unavailable": {
      const reset = /rate limit resets at (\S+)/.exec(reason)?.[1];
      if (reset !== undefined) return `Wait until ${reset}, then rerun: ${wrapper}`;
      if (/rate.limit/i.test(reason)) return `Wait for the GitHub rate limit to reset, then rerun: ${wrapper}`;
      return wrapper;
    }
    case "census_stale": case "census_repository_mismatch": case "census_race":
      return wrapper;
    case "census_credentials_unavailable":
      return `Set GH_READ_ONLY_TOKEN to a readable repository token or run gh auth login --hostname github.com, then rerun: ${wrapper}`;
    case "operator_token_missing": return wrapper;
    case "operator_token_forbidden": return "Remove-Item Env:ROADMAP_SHADOW_PUBLISH_TOKEN; rerun the dry-run command without a publish credential.";
    case "source_not_committed": return "git status --short; commit the intended source and regenerate its cited sidecar before rerunning filing.";
    case "candidate_repository_mismatch": return "Rerun the wrapper with -Repository matching the candidate sidecar's repository.";
    case "assessor_unavailable": {
      const code = /^assessor_unavailable:\s*([a-z_]+):/.exec(reason)?.[1];
      if (code === VIEW_CAP_EXCEEDED_CODE) {
        const cap = /the view cap is (\d+)/.exec(reason)?.[1];
        return `The assessment evidence view is over its ${cap === undefined ? "" : `${cap}-character `}view cap even after trimming optional bodies and excerpting long mandatory bodies; this is not a Codex seat failure. Do not retry unchanged: raise ASSESSMENT_EVIDENCE_VIEW_CHARACTER_CAP in scripts/lib/github-issue-roadmap/assessment-evidence-view.ts within the ${ASSESSMENT_SEAT_INPUT_CHARACTER_CAP}-character seat input cap, or reduce the fixed per-issue payload.`;
      }
      if (code === SEAT_INPUT_CAP_EXCEEDED_CODE) {
        const cap = /the seat input cap is (\d+)/.exec(reason)?.[1] ?? String(ASSESSMENT_SEAT_INPUT_CHARACTER_CAP);
        return `The assessment input is over the ${cap}-character seat input cap; this is not a Codex seat failure. Do not retry unchanged: lower ASSESSMENT_EVIDENCE_VIEW_CHARACTER_CAP in scripts/lib/github-issue-roadmap/assessment-evidence-view.ts or shrink the candidate envelope so the input fits.`;
      }
      return "Get-Command codex.cmd; codex login status; restore the requested Codex seat and rerun filing.";
    }
    case "credential_unreadable": return `${wrapper} -CredentialPath '<absolute-readable-DPAPI-file>' (use the Windows account that protected it).`;
    case "repository_create_budget_exhausted": return "Wait for the repository create-budget window to reopen, then rerun the filing command.";
    case "repository_create_budget_unavailable": return "Inspect and reconcile the repository execution journal and its timestamps before retrying; do not bypass the create ceiling.";
    case "run_evidence_invalid": return "Inspect the run evidence validation error and regenerate the bound artifacts before rerunning filing.";
    default: return `Get-Content -LiteralPath ${quote(join(runRoot, "result.json"))}; inspect the refusal and reconcile any unresolved journal operation or unverified classification before retrying. Do not redispatch an unresolved create.`;
  }
}

class FileFindingRunError extends Error {
  constructor(readonly resultContext: Pick<FileFindingResult, "runRoot" | "requestedAssessor" | "metrics"> & {
    readonly envelope: OutcomeEnvelope; readonly infrastructureNotes?: readonly string[]; readonly completed?: readonly FileFindingCandidateResult[];
  }, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

class FileFindingPublicationError extends Error {}

function publishResult(result: FileFindingResult, args: ReturnType<typeof argumentsMap>, repoRoot: string, log: (line: string) => void): FileFindingResult {
  try {
    mkdirSync(result.runRoot, { recursive: true });
    writeFileSync(join(result.runRoot, "result.json"), prettyCanonicalJson(result), { flag: "wx" });
    if (args.result !== undefined) writeFileSync(resolve(repoRoot, args.result), prettyCanonicalJson(result), { flag: "wx" });
  } catch (cause) {
    throw new FileFindingPublicationError(`result_publication_failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  log(prettyCanonicalJson(result));
  return result;
}

export async function runFileFindingCli(input: {
  readonly argv: readonly string[];
  readonly repoRoot?: string;
  readonly operatorToken?: string;
  readonly runGit?: GitRunner;
  readonly dispositionHistory?: typeof dispositionHistory;
  readonly criteriaAuthorship?: CriteriaAuthorshipLookup;
  readonly caller?: IntakeAssessmentModelCaller;
  readonly runPreflightCli?: typeof runPreflightCli;
  readonly runIntakePreflightCli?: typeof runIntakePreflightCli;
  readonly runBoardCheckGh?: GhRunner;
  readonly openTransport?: () => OperatorIntakeApprovalTransport;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly log?: (line: string) => void;
}): Promise<FileFindingResult> {
  const args = argumentsMap(input.argv);
  const token = input.operatorToken;
  if (args.execute && !token?.trim()) throw new Error("operator_token_missing: --execute requires a released ROADMAP_SHADOW_PUBLISH_TOKEN.");
  if (!args.execute && token?.trim()) throw new Error("operator_token_forbidden: a publish token is allowed only with --execute.");
  const repoRoot = resolve(input.repoRoot ?? process.cwd());
  const now = input.now ?? (() => new Date());
  const metrics: FileFindingMetrics = { durationsMs: {}, githubReads: { canonical: 0, intake: 0 } };
  const startStage = (stage: keyof FileFindingMetrics["durationsMs"]) => {
    const startedAt = now().getTime();
    return () => { metrics.durationsMs[stage] = (metrics.durationsMs[stage] ?? 0) + now().getTime() - startedAt; };
  };
  const measureStage = <T>(stage: keyof FileFindingMetrics["durationsMs"], run: () => T): T => {
    const stop = startStage(stage);
    try { return run(); } finally { stop(); }
  };
  const measureAsyncStage = async <T>(stage: keyof FileFindingMetrics["durationsMs"], run: () => Promise<T>): Promise<T> => {
    const stop = startStage(stage);
    try { return await run(); } finally { stop(); }
  };
  const countReads = (stage: string, runGh: GhRunner): GhRunner => args => {
    metrics.githubReads[stage] = (metrics.githubReads[stage] ?? 0) + 1;
    return runGh(args);
  };
  const log = input.log ?? console.log;
  const runGit = input.runGit ?? runCredentialCleanGit;
  const deliveryGit = localDeliveryGit(runGit);
  const delivery = args.delivery === undefined ? undefined : (() => {
    assertDeliveryInboxOutsideWorktrees(repoRoot, args.repository, deliveryGit);
    return readFindingDelivery(resolve(repoRoot, args.delivery), args.repository);
  })();
  const raw = delivery === undefined
    ? JSON.parse(readFileSync(resolve(repoRoot, args.candidate!), "utf8"))
    : (() => {
      if (delivery.envelopeSha256.startsWith("unreadable-") && !delivery.verification.deliverable) {
        throw new Error(`delivery_undeliverable: ${delivery.verification.reason}`);
      }
      try { return deliveryEnvelope(Buffer.from(delivery.envelopeBase64, "base64"), delivery.sidecarLocator, args.repository); }
      catch (cause) {
        if (delivery.verification.deliverable) throw cause;
        throw new Error(`delivery_undeliverable: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      }
    })();
  // The five-candidate cap counts effective active candidates, so it waits for main history.
  assertIntakeEnvelopeByteBudgets(raw);
  const originalEnvelope = parseOutcomeEnvelope(raw);
  let envelope = originalEnvelope;
  const repository = `${envelope.repository.organization}/${envelope.repository.name}`;
  if (args.repository.toLowerCase() !== repository.toLowerCase()) throw new Error("candidate_repository_mismatch: --repository differs from the candidate.");
  let mainHistory: ReturnType<typeof dispositionHistory>;
  const verifySources = () => delivery === undefined ? assertCommittedSources(repoRoot, envelope, runGit)
    : (verifyFindingDelivery(repoRoot, delivery, deliveryGit, mainHistory), delivery.commit);

  // Give the existing artifact writers their own repository-shaped workspace. This
  // keeps request archives, exchange files and shadow observations inside this run.
  const runId = `finding-${randomUUID()}`;
  const runRoot = join(repoRoot, FILE_FINDING_ROOT, "runs", runId);
  assertRoadmapArtifactOutputPath(join(runRoot, "result.json"), repoRoot);
  const assessor = requestedAssessor(repoRoot);
  let replays: FileFindingCandidateResult[] = [];
  const completed: FileFindingCandidateResult[] = [];
  let apply: IntakeApplyResult | undefined;
  const breaker = new IntakeExecutionBreaker();
  let openedTransport: OperatorIntakeApprovalTransport | undefined;
  const openTransport = () => openedTransport ??= (input.openTransport ?? (() => createGitHubIntakeApprovalTransport({ token: token! })))();
  const finish = (candidates: readonly FileFindingCandidateResult[], apply?: IntakeApplyResult,
    status: FileFindingResult["status"] = args.execute ? "completed" : "dry-run"): FileFindingResult => {
    const results = originalEnvelope.candidates.map((candidate): FileFindingCandidateResult => {
      const result = [...replays, ...completed, ...candidates]
        .find(result => result.sourceFingerprint === candidate.sourceFingerprint);
      if (result !== undefined) return result;
      const reason = `missing_plan_entry: ${candidate.sourceFingerprint} (${candidate.stableOutcomeId}) has no filing result.`;
      return { sourceFingerprint: candidate.sourceFingerprint, stableOutcomeId: candidate.stableOutcomeId,
        disposition: "refused", reason, fixingCommand: fileFindingFixingCommand(reason, args, runRoot) };
    });
    const appended = results.filter(result => result.disposition === "appended" || result.disposition === "closed");
    return {
      schemaVersion: 1, runRoot, requestedAssessor: assessor, status, candidates: results, metrics,
      appends: {
        marker: appended.filter(result => result.appendKind === "marker").map(result => result.issueNumber!),
        modelJudged: appended.filter(result => result.appendKind === "model_overlap").map(result => result.issueNumber!),
      },
      ...(apply === undefined ? {} : { apply }),
    };
  };
  let claim: ExecutionClaim | undefined;
  let runFailure: Error | undefined;
  const infrastructureNotes: string[] = [];
  const result = await (async () => {
  try {
    if (originalEnvelope.candidates.length === 0 && delivery === undefined) return finish([], undefined, "no-op");
    let mainHistorySha = dispositionHistoryRef("origin/main", { repoRoot, runGit });
    mainHistory = (input.dispositionHistory ?? dispositionHistory)(mainHistorySha, { repoRoot, runGit });
    assertEffectiveIntakeEnvelopeBudgets(raw, originalEnvelope, mainHistory);
    const effective = effectiveOutcomeCandidates(originalEnvelope, mainHistory);
    // Admission baselines cover the original envelope, including replayed and
    // dispositioned candidates, and survive every assessment/census retry.
    const authorshipByFingerprint = new Map<string, CriteriaAuthorship>();
    for (const outcome of originalEnvelope.candidates) {
      if (outcome.acceptanceCriteria?.length) authorshipByFingerprint.set(outcome.sourceFingerprint,
        (input.criteriaAuthorship ?? criteriaAuthorship)(outcome.sourceFingerprint,
          outcome.emissionContentSha256, mainHistorySha, { repoRoot, runGit }));
    }
    let repinned = false;
    const driftError = (nextSha: string, cause?: unknown) => new Error(
      `disposition_history_drifted: origin/main changed from ${mainHistorySha} to ${nextSha} before apply; rerun filing.`, { cause });
    const repin = (nextSha: string) => {
      try {
        if (repinned) throw new Error("The run already re-pinned once.");
        runGit(repoRoot, ["merge-base", "--is-ancestor", mainHistorySha, nextSha], { localObjectsOnly: true });
        const nextHistory = (input.dispositionHistory ?? dispositionHistory)(nextSha, { repoRoot, runGit });
        assertEffectiveIntakeEnvelopeBudgets(raw, originalEnvelope, nextHistory);
        if (canonicalJsonSha256(effectiveOutcomeCandidates(originalEnvelope, nextHistory)) !== canonicalJsonSha256(effective)) {
          throw new Error("The original candidate selection changed.");
        }
        for (const outcome of originalEnvelope.candidates) {
          // Compare every entry for this outcome across artifacts, independent of
          // history traversal order. Other outcomes do not invalidate this run.
          const entries = (history: typeof mainHistory) => (history.get(outcome.stableOutcomeId) ?? [])
            .map(entry => canonicalJsonSha256(entry)).sort();
          if (canonicalJsonSha256(entries(mainHistory)) !== canonicalJsonSha256(entries(nextHistory))) {
            throw new Error("Candidate disposition history changed.");
          }
          if (outcome.acceptanceCriteria?.length && canonicalJsonSha256((input.criteriaAuthorship ?? criteriaAuthorship)(
            outcome.sourceFingerprint, outcome.emissionContentSha256, nextSha, { repoRoot, runGit }))
              !== canonicalJsonSha256(authorshipByFingerprint.get(outcome.sourceFingerprint))) {
            throw new Error("Candidate criteria authorship changed.");
          }
        }
        if (delivery !== undefined) verifyFindingDelivery(repoRoot, delivery, deliveryGit, nextHistory);
        mainHistorySha = nextSha;
        mainHistory = nextHistory;
        repinned = true;
      } catch (cause) { throw driftError(nextSha, cause); }
    };
    for (const candidate of effective.dispositioned) completed.push({ sourceFingerprint: candidate.sourceFingerprint,
      stableOutcomeId: candidate.stableOutcomeId, disposition: "dispositioned", reason: "dispositioned" });
    envelope = { ...originalEnvelope, candidates: effective.active };
    if (delivery !== undefined) verifyFindingDelivery(repoRoot, delivery, deliveryGit, mainHistory);
    if (envelope.candidates.length === 0) return finish([], undefined, "no-op");
    const journalPath = resolveJournalPath(repository);
    let history = indexHistory([]);
    const replayNeedsApply = new Set<string>();
    const readCandidateHistory = () => {
      const journal = readJournal(journalPath);
      history = indexHistory(journal.records, journal.tail);
      const unresolved = new Set<string>();
      replays = [];
      replayNeedsApply.clear();
      for (const candidate of effective.active) {
        const identity = { repository, sourceFingerprint: candidate.sourceFingerprint };
        const create = resolveDurableState(history, { ...identity, action: "create_issue" });
        if (["intent_unknown", "unresolved_unknown", "unresolved_partial"].includes(create.kind)) {
          unresolved.add(candidate.sourceFingerprint);
        }
        const states = [create, resolveSubmittedReplayState(history, { ...identity, action: "append_evidence",
          emissionContentSha256: candidate.emissionContentSha256 })];
        // Only an exact completed append can replay past another emission's
        // unfinished/abandoned append. New work still checks that safety history.
        if (journal.tail !== null || states.some(state => state.kind !== "never_attempted" && state.kind !== "complete")) {
          replayNeedsApply.add(candidate.sourceFingerprint);
          continue;
        }
        for (const state of states) {
          if (journal.tail === null && state.kind === "complete" && state.operation.event.event === "complete"
            && state.operation.event.emissionContentSha256 === candidate.emissionContentSha256
            && state.operation.result.issueNumber !== null) {
            replays.push({ sourceFingerprint: candidate.sourceFingerprint, stableOutcomeId: candidate.stableOutcomeId, disposition: "replay",
              reason: "already_filed", issueNumber: state.operation.result.issueNumber });
            break;
          }
        }
      }
      envelope = { ...originalEnvelope, candidates: effective.active.filter(candidate =>
        !replays.some(replay => replay.sourceFingerprint === candidate.sourceFingerprint)) };
      return unresolved;
    };
    readCandidateHistory();
    if (envelope.candidates.length === 0) return finish([]);
    claim = await measureAsyncStage("claimWait", async () => {
      const deadline = now().getTime() + args.waitMinutes * 60_000;
      let backoffMs = 5_000;
      for (;;) {
        try { return acquireExecutionClaim(journalPath, { mode: args.execute ? "execute" : "preflight" }); }
        catch (error) {
          if (!(error instanceof ExecutionClaimRefusedError) || error.reason !== "live_holder") throw error;
          const currentTime = now().getTime();
          const remainingMs = deadline - currentTime;
          if (remainingMs <= 0) throw error;
          // ExecutionClaimRefusedError's live-holder message carries these fields.
          const holder = /, acquiredAt (\S+), mode ([\w-]+)\./.exec(error.message);
          const delayMs = Math.min(backoffMs, remainingMs);
          const holderText = holder === null ? error.message
            : `mode=${holder[2]}, age=${Math.max(0, Math.floor((currentTime - Date.parse(holder[1])) / 1000))}s`;
          log(`Waiting for live intake claim (${holderText}); retrying in ${delayMs / 1000}s.`);
          await (input.sleep ?? sleep)(delayMs);
          backoffMs = Math.min(backoffMs * 2, 60_000);
        }
      }
    });
    // Another run may have completed between our cheap read and acquiring ownership.
    const unresolved = claim.withOwnership(readCandidateHistory);
    if (envelope.candidates.length === 0) return finish([]);
    const head = delivery?.commit ?? verifySources();
    let captureNumber = 0;
    let censusPath = args.census === undefined ? assertSharedCensusPath(repository, claim) : resolve(repoRoot, args.census);
    const captureCensus = (): IntakeSnapshotV1 => measureStage("census", () => {
      metrics.censusMode = "capture";
      for (let attempt = 0; attempt < 2; attempt++) {
        const captureRoot = join(runRoot, "captures", String(++captureNumber));
        mkdirSync(dirname(captureRoot), { recursive: true });
        // Never reuse an attempt's output paths, including after a partial capture.
        mkdirSync(captureRoot);
        const candidatePath = join(captureRoot, "candidate.json");
        const canonicalPath = join(captureRoot, "canonical.json");
        const intakePath = join(captureRoot, "intake-snapshot.json");
        const passPath = join(captureRoot, "intake-pass.json");
        const fingerprintPath = join(captureRoot, "board-fingerprint.json");
        writeFileSync(candidatePath, prettyCanonicalJson(envelope), { flag: "wx" });
        try {
          const readGh = countReads("intake", createCensusReader());
          claim!.withOwnership(() => inWorkingDirectory(repoRoot, () => {
            withCensusCredentials(() => (input.runPreflightCli ?? runPreflightCli)([
              `--repo=${repository}`, `--out=${canonicalPath}`, "--snapshot-version=v2", `--fingerprint-out=${fingerprintPath}`,
            ], countReads("canonical", createGhRunner())));
            (input.runIntakePreflightCli ?? runIntakePreflightCli)([
              `--candidate=${candidatePath}`, `--snapshot=${canonicalPath}`, `--out=${intakePath}`, `--fingerprint=${fingerprintPath}`, `--census-pass-out=${passPath}`,
            ], repoRoot, readGh, claim, { dispositionHistory: () => mainHistory });
          }));
          const capturedContents = readFileSync(intakePath, "utf8");
          const captured = parseIntakeSnapshotV1(JSON.parse(capturedContents));
          if (canonicalJsonSha256(captured.repository) !== canonicalJsonSha256(envelope.repository)) {
            throw new Error("census_repository_mismatch: captured census and candidate repository identities disagree.");
          }
          if (captured.candidateSha256 !== canonicalJsonSha256(envelope)) {
            throw new Error("census_unavailable: captured census is not bound to the unresolved envelope.");
          }
          assertFresh(captured, now());
          const journal = claim!.withOwnership(() => readJournal(journalPath));
          const rawCensus = JSON.parse(readFileSync(passPath, "utf8")) as { pass: IntakeCensusPass; bookend: SerializedIntakeIssueIndex };
          // Run copies remain immutable evidence; publish the reusable pair together.
          publishSharedCensus(repository, claim!, {
            schemaVersion: "github-issue-roadmap-shared-census/v3", repository: captured.repository,
            publishedAt: now().toISOString(),
            canonicalSnapshot: parseCanonicalSnapshotV2(JSON.parse(readFileSync(canonicalPath, "utf8"))),
            intakeSnapshot: captured,
            intakePass: rawCensus.pass, intakeBookend: rawCensus.bookend,
            boardFingerprint: parseBoardFingerprint(JSON.parse(readFileSync(fingerprintPath, "utf8"))),
            journalPosition: journalPositionOf(journal),
          });
          censusPath = intakePath;
          return captured;
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          if (/Pull-request exclusion count changed|GitHub (?:issues|issue hydration) changed during|census changed during collection|census.*(?:changed|drift)|(?:issue|pull.request).*count changed/i.test(reason)) {
            if (attempt === 0) continue;
            throw new Error(`census_race: GitHub changed during both capture attempts; rerun filing. ${reason}`, { cause });
          }
          const details = `${reason}\n${String((cause as { stderr?: unknown })?.stderr ?? "")}`;
          if (/rate_limited|rate limit|secondary rate|abuse detection|retry-after/i.test(details)) {
            const epoch = /"resetEpoch"\s*:\s*"?(\d+)/.exec(details)?.[1] ?? /x-ratelimit-reset:\s*(\d+)/i.exec(details)?.[1];
            const reset = epoch === undefined ? NaN : Number(epoch) * 1000;
            const resetTime = Number.isFinite(reset) && !Number.isNaN(new Date(reset).getTime()) ? new Date(reset).toISOString() : undefined;
            throw new Error(`census_unavailable: GitHub rate limit${resetTime === undefined ? "; reset time unavailable" : ` resets at ${resetTime}`} (${reason})`, { cause });
          }
          if (/auth login|not logged|authentication|bad credentials|HTTP 401|HTTP 403|requires authentication|spawn(?:Sync)? gh ENOENT|ambient mutation-capable credentials/i.test(details)) {
            throw new Error("census_credentials_unavailable: census capture requires GH_READ_ONLY_TOKEN or a usable gh login.", { cause });
          }
          if (/^census_/.test(reason) || cause instanceof Error && cause.name === "ExecutionOwnershipError") throw cause;
          throw new Error(`census_unavailable: ${reason}`, { cause });
        }
      }
      throw new Error("census_race: capture retry exhausted; rerun filing.");
    });
    const cachedCensus = measureStage("census", () => claim!.withOwnership(() => {
      if (args.freshCensus) return undefined;
      // Store containment and ownership failures remain refusals, outside the miss path.
      let bundle = args.census === undefined ? readSharedCensus(envelope.repository, claim!) : undefined;
      try {
        if (args.census !== undefined) {
          const explicitCensus = JSON.parse(readFileSync(censusPath, "utf8"));
          const identities = [explicitCensus?.repository, explicitCensus?.intakeSnapshot?.repository, explicitCensus?.canonicalSnapshot?.repository];
          if (identities.some(identity => identity !== undefined && canonicalJsonSha256(identity) !== canonicalJsonSha256(envelope.repository)) ||
              explicitCensus?.boardFingerprint?.repositoryFullName !== undefined && explicitCensus.boardFingerprint.repositoryFullName !== repository) {
            throw new Error("census_repository_mismatch: census and candidate must identify the same repository.");
          }
          bundle = parseSharedCensusBundle(explicitCensus, envelope.repository);
        }
        if (bundle === undefined) return undefined;
        const census = bundle.intakeSnapshot;
        const checkedAt = now();
        assertFresh(census, checkedAt);
        if (censusNeedsRefreshBeforeApply(census, new Date(checkedAt.getTime() + 20 * 60_000))) {
          throw new Error("census_stale: fewer than twenty minutes of novelty freshness remain.");
        }
        const journal = readJournal(journalPath);
        const journalCheck = checkCensusJournal(bundle.journalPosition, journal, repository);
        if (!journalCheck.eligible) {
          throw new Error("census_stale: repository journal changed since capture.");
        }
        const readGh = input.runBoardCheckGh ?? createCensusReader();
        const runGh = countReads("boardCheck", readGh);
        const repo = { owner: envelope.repository.organization, name: envelope.repository.name, fullName: repository };
        const boardRead = readBoardFingerprint({ repo, runGh, readGraphql: readGraphqlWithMetadata, fetchedAt: now().toISOString() });
        const board = boardRead.fingerprint;
        const index = collectIntakeIssueIndex({ canonicalSnapshot: bundle.canonicalSnapshot, runGh });
        const drift = detectIntakeCensusDrift(census, index);
        const touched = new Set(journalCheck.touchedIssueNumbers);
        const created = new Set(journalCheck.createdIssueNumbers);
        const priorBoard = bundle.boardFingerprint;
        const boardKeys = new Set([...Object.keys(priorBoard.issues), ...Object.keys(board.issues)]);
        // Equal validated digests mean equal issue maps, so nothing needs attributing.
        const unexplainedBoard = priorBoard.digest !== board.digest && [...boardKeys].some(key => {
          const before = priorBoard.issues[key];
          const after = board.issues[key];
          if (before !== undefined && after !== undefined && canonicalJsonSha256(before) === canonicalJsonSha256(after)) return false;
          // A reopened known issue may appear on the open board; an entirely new
          // issue must also be recorded as a create in the journal.
          return !touched.has(Number(key)) || (before === undefined &&
            !census.issues.some(issue => issue.number === Number(key)) && !created.has(Number(key)));
        });
        if (board.repositoryFullName !== priorBoard.repositoryFullName || unexplainedBoard ||
            drift.appearedIssueNumbers.some(number => !created.has(number)) ||
            drift.movedIssueNumbers.some(number => !touched.has(number)) || drift.disappearedIssueNumbers.length > 0) {
          throw new Error("census_stale: board or issue index changed outside journal writes.");
        }
        if (touched.size === 0) return census;
        // An explicit census is diagnostic input: it is checked, never refreshed into the shared store.
        if (args.census !== undefined) throw new Error("census_stale: explicit census predates pipeline writes; rerun without --census.");
        if (bundle.schemaVersion !== "github-issue-roadmap-shared-census/v3" ||
            [...bundle.canonicalSnapshot.census.nowIssueNumbers, ...boardRead.nowIssueNumbers].some(number => touched.has(number))) {
          throw new Error("census_stale: targeted refresh requires a raw pass and unchanged Now hydration.");
        }
        const refreshGh = countReads("targetedRefresh", readGh);
        const canonicalSnapshot = bundle.canonicalSnapshot;
        const replacements = journalCheck.touchedIssueNumbers.map(issueNumber => collectIntakeIssue({
          canonicalSnapshot, issueNumber, runGh: refreshGh, fetchedAt: now().toISOString(),
        }));
        const issues = new Map(bundle.intakePass.issues.map(issue => [issue.number, issue]));
        for (const replacement of replacements) issues.set(replacement.issue.number, replacement.issue);
        // Keep the original pass start and every original receipt in PASS order.
        // In particular repository comment pages cannot be replaced by one issue's reads.
        const bookend = collectIntakeIssueIndex({ canonicalSnapshot: bundle.canonicalSnapshot, runGh: refreshGh });
        // Pull requests opened since capture change only the exclusion count; issue drift
        // stays guarded by the index comparison below and the closing board fingerprint.
        const pass: IntakeCensusPass = { ...bundle.intakePass, issues: [...issues.values()], expectedIssueCount: issues.size,
          excludedPullRequestCount: bookend.excludedPullRequestCount,
          receipts: [...bundle.intakePass.receipts, ...replacements.flatMap(result => result.receipts)] };
        if (Object.values(detectIntakeCensusDrift(pass, bookend)).some(numbers => numbers.length > 0)) {
          throw new Error("census_stale: issue index drifted during targeted refresh.");
        }
        const closing = readBoardFingerprint({ repo, runGh: refreshGh, readGraphql: readGraphqlWithMetadata, fetchedAt: now().toISOString() });
        assertClosingBoardFingerprint(board, closing.fingerprint, pass.issues);
        const refreshed = buildIntakeSnapshot({ candidateSha256: census.candidateSha256,
          canonicalSnapshotV2Sha256: census.canonicalSnapshotV2Sha256, generatedAt: now().toISOString(),
          pass, bookend, projectObservation: census.projectObservation });
        assertFresh(refreshed, now());
        publishSharedCensus(repository, claim!, { ...bundle, publishedAt: now().toISOString(),
          intakeSnapshot: refreshed, intakePass: pass, intakeBookend: { ...bookend, updatedAt: Object.fromEntries(bookend.updatedAt) },
          boardFingerprint: closing.fingerprint, journalPosition: journalPositionOf(journal) });
        return refreshed;
      } catch (cause) {
        if (cause instanceof Error && cause.name === "ExecutionOwnershipError") throw cause;
        if (args.census === undefined) return undefined;
        if (cause instanceof Error && /^census_(repository_mismatch|stale):/.test(cause.message)) throw cause;
        throw new Error(`census_stale: explicit census could not be verified: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      }
    }));
    if (cachedCensus !== undefined) metrics.censusMode = "reuse";
    let census = cachedCensus ?? captureCensus();
    let refreshed = false;
    const refreshBeforeApply = () => {
      if (!censusNeedsRefreshBeforeApply(census, now())) return false;
      if (args.census !== undefined) throw new Error("census_stale: explicit census expired before apply; rerun filing.");
      if (refreshed) throw new Error("census_stale: the refreshed census expired before apply; rerun filing.");
      envelope = { ...envelope, candidates: envelope.candidates.filter(candidate =>
        !completed.some(result => result.sourceFingerprint === candidate.sourceFingerprint)) };
      census = captureCensus();
      refreshed = true;
      return true;
    };
    for (const locator of [REPO_ASSESSMENT_PROMPT, REPO_STACK_DESCRIPTOR, "scripts/github-issue-roadmap-assessment-schema.json"]) {
      const path = join(runRoot, locator);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, readFileSync(join(repoRoot, locator)), { flag: "wx" });
    }
    log(`Artifacts: ${runRoot}`);
    // Re-enter only on receipt expiry; successful writes never invalidate their siblings' census.
    assessment: for (let assessmentAttempt = 0; ; assessmentAttempt++) {
    const snapshot = rebindCensus(census, envelope);
    let evidenceRoot = join(runRoot, "artifacts/github-issue-roadmap", ...(assessmentAttempt === 0 ? [] : [`refresh-${assessmentAttempt}`]));
    mkdirSync(evidenceRoot, { recursive: true });
    const write = (name: string, contents: string | Buffer) => {
      const path = join(evidenceRoot, name);
      writeFileSync(path, contents, { flag: "wx" });
      return path;
    };
    let candidatePath = write("candidate.json", prettyCanonicalJson(envelope));
    write("census.json", prettyCanonicalJson(census));
    let snapshotPath = write("intake-snapshot.json", prettyCanonicalJson(snapshot));
    write("source-binding.json", prettyCanonicalJson(delivery === undefined
      ? { head, candidatePath: resolve(repoRoot, args.candidate!), censusPath }
      : { deliveryCommit: head, deliveryPath: resolve(repoRoot, args.delivery!), envelopeSha256: delivery.envelopeSha256, censusPath }));
    const request = authorOperatorAssessmentRequestBundle({
      dispositionHistory: () => mainHistory,
      repoRoot: runRoot, exchangeRoot: join(runRoot, assessmentAttempt === 0 ? "exchange" : `exchange-refresh-${assessmentAttempt}`),
      scheduledExchangeRoot: join(repoRoot, ".worktrees/.roadmap-shadow-exchange"),
      candidateLocator: relative(runRoot, candidatePath).replaceAll("\\", "/"),
      intakeSnapshotLocator: relative(runRoot, snapshotPath).replaceAll("\\", "/"),
      // Session SHA validation/checksum only; existence, shadow and apply separately resolve origin/main.
      trustedMainSha: head, now: now(), runDiscriminator: `${runId}-${assessmentAttempt}`, stackLocator: REPO_STACK_DESCRIPTOR,
    });
    const evaluated = await measureAsyncStage("assessment", () => evaluateIntakeAssessmentBundle({ handoffPath: request.operatorHandoffPath, repoRoot, caller: input.caller, dispositionHistory: () => mainHistory })
      .catch((cause: unknown) => {
        if (cause instanceof AssessmentEvidenceViewCapError) {
          throw new Error(`assessor_unavailable: ${cause.message}`, { cause });
        }
        throw new Error(`assessor_unavailable: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      }));
    write("assessment.json", readFileSync(evaluated.assessmentTarget));
    let repinnedExistence: ReturnType<typeof probeExistenceAtSha> | undefined;
    preparation: for (;;) {
    if (refreshBeforeApply()) continue assessment;
    assertFresh(census, now());
    verifySources();
    const existencePath = join(evidenceRoot, "existence.json");
    // Probe immediately before shadow and forward the SHA it resolved, not a second ref read.
    const existence = repinnedExistence ?? measureStage("existenceProbe", () => runExistenceProbeCli([`--candidate=${candidatePath}`, `--out=${existencePath}`], repoRoot, runGit, { dispositionHistory: () => mainHistory }));
    if (repinnedExistence !== undefined) write("existence.json", prettyCanonicalJson(existence));
    if (existence.originMainSha !== mainHistorySha) {
      repin(existence.originMainSha);
    }
    if (refreshBeforeApply()) continue assessment;
    const decisionPath = join(evidenceRoot, "decision.json");
    // Consume the original assessment path so its evaluator coverage sidecar stays
    // bound. The byte-identical sibling above is retained for run-evidence verification.
    const qualificationContext = { ...loadActionQualificationContext(repoRoot, runGit, existence.originMainSha), assessmentStackSha256: currentAssessmentStackHash(runRoot) };
    const qualifications = new Map<string, ReturnType<typeof readActionQualification>>();
    function qualificationFor(kind: string): ReturnType<typeof readActionQualification> {
      let qualification = qualifications.get(kind);
      if (qualification === undefined) {
        qualification = readActionQualification(kind, qualificationContext);
        qualifications.set(kind, qualification);
      }
      return qualification;
    }
    const shadow = withActionQualificationContext(qualificationContext, () => runIntakeShadow({ repoRoot: runRoot, candidate: candidatePath, snapshot: snapshotPath, assessment: evaluated.assessmentTarget,
      existence: existencePath, verifiedOriginMainSha: existence.originMainSha, out: decisionPath, now: now(), log: () => {},
      dispositionHistory: () => mainHistory }));
    const plan = buildIntakeApprovalPlan({ decisionPath, decisionContent: readFileSync(decisionPath, "utf8"), now: now() });
    // Bank every proposed model action before any apply, including siblings left pending
    // by a budget/transport failure and both executable actions and suggestions.
    const materialIds = new Map<string, string>();
    const modelSuggestions = new Map<string, Pick<ActionLabel, "actionKind" | "targetIssueNumber">[]>();
    const observations = readdirSync(join(runRoot, INTAKE_OBSERVATION_DIRECTORY)).filter(name => name.endsWith(".json"))
      .map(name => readIntakeJournalRecord(join(runRoot, INTAKE_OBSERVATION_DIRECTORY, name)));
    for (const entry of plan.entries) {
      const match = shadow.report.decision.candidates.find(candidate => candidate.sourceFingerprint === entry.sourceFingerprint)!;
      const proposed: Pick<ActionLabel, "actionKind" | "targetIssueNumber">[] = [
        ...(match.matchResult === "plausible_overlap" ? match.competingIssueNumbers.map(targetIssueNumber => ({ actionKind: "append_evidence_overlap" as const, targetIssueNumber })) : []),
        ...(entry.closeIssue === null ? [] : [{ actionKind: "close_issue_existence" as const, targetIssueNumber: entry.closeIssue.targetIssueNumber }]),
      ];
      if (proposed.length === 0) continue;
      const observation = observations.find(item => item.schemaVersion === INTAKE_OBSERVATION_SCHEMA_V2
        && item.candidate.sourceFingerprint === entry.sourceFingerprint && item.decisionSha256 === canonicalJsonSha256(shadow.report.decision));
      if (observation?.schemaVersion !== INTAKE_OBSERVATION_SCHEMA_V2) throw new Error("action_material_missing: filing observation is unavailable.");
      bankActionJudgementMaterial({ runRoot, repoRoot, judgementRoot: resolveActionJudgementRoot(), observation, suggestions: proposed });
      materialIds.set(entry.sourceFingerprint, observation.observationId);
      modelSuggestions.set(entry.sourceFingerprint, proposed);
      log(`Action judgement material: ${observation.observationId}; label with npm run roadmap:judge -- --observation-id=${observation.observationId} --action-kind=${proposed[0].actionKind} --target-issue=${proposed[0].targetIssueNumber} --action-verdict=correct --judged-by=human_operator --judged-at=<ISO-timestamp>`);
    }
    for (const [entryIndex, entry] of plan.entries.entries()) {
    if (completed.some(candidate => candidate.sourceFingerprint === entry.sourceFingerprint)) continue;
    const outcome = envelope.candidates.find(candidate => candidate.sourceFingerprint === entry.sourceFingerprint)!;
    const identity = { sourceFingerprint: outcome.sourceFingerprint, stableOutcomeId: outcome.stableOutcomeId };
    const qualifiedClose = entry.intendedActions.includes("close_issue_existence")
      && qualificationFor("close_issue_existence").executable;
    entry.approved = entry.approvable && (entry.intendedAction === "create_issue"
      || entry.intendedAction === "append_evidence_overlap" && entry.closeIssue === null
        && qualificationFor("append_evidence_overlap").executable
      || entry.intendedAction === "append_evidence" && (entry.closeIssue !== null ? qualifiedClose
        : (census.markerIndex[entry.sourceFingerprint] ?? []).some(location =>
          location.issueNumber === entry.canonicalIssueNumber)));
    const match = shadow.report.decision.candidates.find(candidate => candidate.sourceFingerprint === entry.sourceFingerprint);
    function candidateSuggestion(): FileFindingCandidateResult["suggestion"] {
      if (entry.closeIssue !== null && !entry.approved) {
        return { kind: "close", targetIssueNumber: entry.closeIssue.targetIssueNumber };
      }
      if (entry.intendedAction === "create_issue" && match?.matchResult === "plausible_overlap" && match.competingIssueNumbers.length > 0) {
        return { kind: "append", targetIssueNumber: match.competingIssueNumbers[0] };
      }
      if (!entry.approved && ["append_evidence", "append_evidence_overlap"].includes(entry.intendedAction ?? "") && entry.canonicalIssueNumber !== null) {
        return { kind: "append", targetIssueNumber: entry.canonicalIssueNumber };
      }
      return undefined;
    }
    const suggestion = candidateSuggestion();
    const suggestions = suggestion?.kind === "append" && entry.intendedAction === "create_issue" && match?.matchResult === "plausible_overlap"
      ? match.competingIssueNumbers.map(targetIssueNumber => ({ kind: "append" as const, targetIssueNumber }))
      : suggestion === undefined ? [] : [suggestion];
    const actionQualification = [...new Set((modelSuggestions.get(entry.sourceFingerprint) ?? []).map(item => item.actionKind))]
      .filter(kind => !qualificationFor(kind).executable)
      .map(kind => ({ kind, reason: qualificationFor(kind).reason, fixingCommand: ACTION_QUALIFICATION_COMMAND }));
    const annotatedIdentity = { ...identity, ...(suggestion === undefined ? {} : { suggestion, suggestions }),
      ...(materialIds.has(entry.sourceFingerprint) ? { judgementObservationId: materialIds.get(entry.sourceFingerprint) } : {}),
      ...(actionQualification.length > 0 ? { actionQualification, fixingCommand: ACTION_QUALIFICATION_COMMAND } : {}),
      ...(entry.intendedAction === "append_evidence_overlap" ? { appendKind: "model_overlap" as const }
        : entry.intendedAction === "append_evidence" ? { appendKind: "marker" as const } : {}) };
    if (entry.approved && entry.closeIssue !== null && args.execute && openTransport().supportsCloseIssue !== true) {
      const reason = "close_unsupported: transport cannot complete append-then-close; no evidence comment was posted.";
      completed.push({ ...annotatedIdentity, disposition: "refused", reason,
        fixingCommand: fileFindingFixingCommand(reason, args, runRoot) });
      continue;
    }
    const recoverMarkerReplay = entry.presentation === "replay_no_op" && replayNeedsApply.has(identity.sourceFingerprint);
    if (!entry.approved && !recoverMarkerReplay && (!unresolved.has(identity.sourceFingerprint) || entry.closeIssue !== null)) {
      completed.push(entry.presentation === "replay_no_op" && entry.replay?.targetIssueNumber != null
        ? { ...annotatedIdentity, disposition: "replay", reason: "already_filed", issueNumber: entry.replay.targetIssueNumber }
        : { ...annotatedIdentity, disposition: "hold", reason: entry.hold?.reason ?? "existing_issue_requires_operator",
          competingIssues: entry.hold?.competingIssueNumbers ?? (entry.canonicalIssueNumber === null ? [] : [entry.canonicalIssueNumber]) });
      continue;
    }
    const planName = entryIndex === 0 ? "approval-plan.json" : `approval-plan-${entryIndex}.json`;
    const evidenceName = entryIndex === 0 ? "run-evidence.json" : `run-evidence-${entryIndex}.json`;
    // Apply recovers historical operations even for unapproved entries. Present only
    // this candidate, retaining the complete compiled decision and its evidence bindings.
    const applyDecisionName = plan.entries.length === 1 ? "decision.json" : `decision-${entryIndex}.json`;
    const applyDecisionPath = plan.entries.length === 1 ? decisionPath : write(applyDecisionName, prettyCanonicalJson({
      ...shadow.report, candidates: shadow.report.candidates.filter(candidate => candidate.sourceFingerprint === entry.sourceFingerprint),
    }));
    const applyPlan = buildIntakeApprovalPlan({ decisionPath: applyDecisionPath,
      decisionContent: readFileSync(applyDecisionPath, "utf8"), now: now() });
    applyPlan.entries[0].approved = entry.approved;
    const planPath = write(planName, prettyCanonicalJson(applyPlan));
    const sibling = (name: string) => ({ path: basename(name), bytes: readFileSync(join(evidenceRoot, name)) });
    const built = buildRunEvidence({
      runId, repository, preparedAt: now().toISOString(), approvalPlan: sibling(planName), census: sibling("census.json"),
      decisions: [{ decision: sibling(applyDecisionName), candidate: sibling("candidate.json"), snapshot: sibling("intake-snapshot.json"), assessment: sibling("assessment.json"),
        ...(authorshipByFingerprint.get(outcome.sourceFingerprint) === "unknown" ? { candidateAnnotations: [{
            sourceFingerprint: outcome.sourceFingerprint, emissionContentSha256: outcome.emissionContentSha256,
            criteriaAuthorship: "unknown" as const,
          }] } : {}),
      }],
    });
    if (!built.ok) throw new Error(`run_evidence_invalid: ${built.reason}: ${built.detail}`);
    const runEvidencePath = write(evidenceName, prettyCanonicalJson(built.evidence));
    if (refreshBeforeApply()) continue assessment;
    assertFresh(census, now());
    const priorState = (entry.presentation === "replay_no_op" ? resolveSubmittedReplayState : resolveDurableState)(history, { repository, sourceFingerprint: entry.sourceFingerprint,
      action: entry.intendedAction === "create_issue" ? "create_issue" : entry.intendedAction === null ? null : "append_evidence",
      emissionContentSha256: outcome.emissionContentSha256 });
    const latestMainSha = dispositionHistoryRef("origin/main", { repoRoot, runGit });
    if (latestMainSha !== mainHistorySha) {
      if (repinned) throw driftError(latestMainSha);
      try {
        const latestExistence = measureStage("existenceProbe", () => probeExistenceAtSha({
          envelope, originMainSha: latestMainSha, repoRoot, runGit, budget: Number.MAX_SAFE_INTEGER,
          generatedAt: now().toISOString(), dispositionHistory: () => mainHistory,
        }));
        if (!envelope.candidates.every(candidate => latestExistence.entries.some(entry =>
          entry.sourceFingerprint === candidate.sourceFingerprint && entry.emissionContentSha256 === candidate.emissionContentSha256
          && "state" in entry && entry.state === "not_demonstrated"))) throw new Error("Candidates no longer clear the existence probe.");
        repin(latestMainSha);
        repinnedExistence = latestExistence;
      } catch (cause) { throw driftError(latestMainSha, cause); }
      // Apply binds the existence digest to the compiled decision. Recompile and
      // rebuild approval/evidence at the new pin without repeating assessment or
      // overwriting any artifact that may already have supported a sibling write.
      const priorEvidenceRoot = evidenceRoot;
      evidenceRoot = join(evidenceRoot, "repin");
      mkdirSync(evidenceRoot);
      for (const name of ["candidate.json", "census.json", "intake-snapshot.json", "assessment.json", "source-binding.json"]) {
        write(name, readFileSync(join(priorEvidenceRoot, name)));
      }
      candidatePath = join(evidenceRoot, "candidate.json");
      snapshotPath = join(evidenceRoot, "intake-snapshot.json");
      continue preparation;
    }
    // Apply rechecks model authority with the explicit context before transport I/O.
    const applied = await measureAsyncStage("apply", () => runIntakeApplyCli({
      argv: [`--plan=${planPath}`, `--run-evidence=${runEvidencePath}`, ...(args.execute
        ? ["--execute", `--candidate=${candidatePath}`, `--existence=${existencePath}`, `--origin-main-sha=${existence.originMainSha}`] : [])],
      repoRoot, runGit, dispositionHistory: input.dispositionHistory, operatorToken: token, immediate: true, heldClaim: claim, actionQualificationContext: qualificationContext,
      openTransport: args.execute ? openTransport : undefined,
      log: () => {},
    }));
    const record = applied.ledgerRecords.find(record => record.sourceFingerprint === identity.sourceFingerprint);
    apply = applied;
    const complete = record?.durableState === "complete" && applied.failures.length === 0 && !applied.ownership?.releaseError;
    // Apply owns status-aware fault detection; the command carries its dispatch
    // failure count across the otherwise independent per-candidate invocations.
    for (const failure of applied.failures) breaker.recordFailure(failure, failure.error);
    if (complete && priorState.kind === "never_attempted") breaker.recordComplete("classification");
    const aborted = applied.aborted ?? breaker.aborted;
    // Apply's `executed` describes durable history, including prior invocations;
    // its approved, never-attempted dry-run projection is intentionally `refused`.
    const infrastructureReason = aborted === undefined ? applied.failures.map(failure => infrastructureFailureReason(failure.error)).find(reason => reason !== undefined)
      : `${aborted.reason}: ${aborted.error}`;
    const reconciliation = applied.reconciliations.find(result => result.sourceFingerprint === identity.sourceFingerprint && result.outcome === "refused");
    const reason = infrastructureReason ?? (reconciliation === undefined ? undefined : `${reconciliation.reason}: ${reconciliation.detail}`)
      ?? record?.refusalReason ?? applied.failures[0]?.error ?? applied.ownership?.releaseError ?? "execution_incomplete";
    function completeDisposition(record: IntakeApplyResult["ledgerRecords"][number]): "replay" | "closed" | "appended" | "filed" {
      if (!args.execute || priorState.kind === "complete") return "replay";
      if (entry.closeIssue !== null) return "closed";
      if (record.actionTaken === "append_evidence") return "appended";
      return "filed";
    }
    function classifyCandidate(): FileFindingCandidateResult {
      if (record?.durableState === "withdrawn_dispositioned") {
        return { ...identity, disposition: "dispositioned", reason: "dispositioned" };
      }
      if (complete && record.result.issueNumber !== null) {
        const disposition = completeDisposition(record);
        return { ...annotatedIdentity, disposition, reason: disposition === "replay" ? "already_filed" : "complete_and_verified", issueNumber: record.result.issueNumber };
      }
      if (infrastructureReason !== undefined) {
        return { ...annotatedIdentity, disposition: "interrupted", reason, fixingCommand: fileFindingFixingCommand(reason, args, runRoot) };
      }
      if (!args.execute && record?.durableState === "never_attempted") {
        return { ...annotatedIdentity, disposition: "dry-run", reason: "execution_not_requested", projectedAction: entry.intendedAction };
      }
      if (reason.split(":", 1)[0] === "repository_create_budget_exhausted") {
        return { ...annotatedIdentity, disposition: "pending", reason, fixingCommand: fileFindingFixingCommand(reason, args, runRoot) };
      }
      return { ...annotatedIdentity, disposition: "refused", reason, fixingCommand: fileFindingFixingCommand(reason, args, runRoot) };
    }
    const candidate = classifyCandidate();
    completed.push(candidate);
    if (candidate.issueNumber !== undefined) log(`Issue #${candidate.issueNumber} complete and verified.`);
    if (candidate.disposition === "pending" || infrastructureReason !== undefined) {
      for (const remaining of envelope.candidates.filter(outcome => !completed.some(result => result.sourceFingerprint === outcome.sourceFingerprint))) {
        completed.push({ sourceFingerprint: remaining.sourceFingerprint, stableOutcomeId: remaining.stableOutcomeId,
          disposition: infrastructureReason === undefined ? "pending" : "interrupted", reason,
          fixingCommand: fileFindingFixingCommand(reason, args, runRoot) });
      }
      return finish([], apply, infrastructureReason === undefined ? undefined : "infrastructure");
    }
    }
    return finish([], apply);
    }
    }
  } catch (cause) {
    runFailure = cause instanceof FileFindingPublicationError ? cause
      : new FileFindingRunError({ runRoot, requestedAssessor: assessor, envelope: originalEnvelope, metrics,
        completed: [...replays, ...completed], infrastructureNotes }, cause);
    throw runFailure;
  } finally {
    try { claim?.release(); }
    catch (cause) {
      infrastructureNotes.push(`claim_release_failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      if (runFailure !== undefined) Object.defineProperty(runFailure, "suppressed", { value: [cause], configurable: true });
    }
  }
  })();
  return publishResult(infrastructureNotes.length === 0 ? result
    : { ...result, status: "infrastructure", infrastructureNotes }, args, repoRoot, log);
}

export async function runFileFindingCommand(input: Parameters<typeof runFileFindingCli>[0]): Promise<0 | 1 | 2 | 4 | 5> {
  try { return fileFindingExitCode(await runFileFindingCli(input)); }
  catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof FileFindingPublicationError) { console.error(reason); return 4; }
    try {
      const args = argumentsMap(input.argv);
      const repoRoot = resolve(input.repoRoot ?? process.cwd());
      // Recovery reads identify refused candidates only; they authorize no pipeline work.
      const context = error instanceof FileFindingRunError ? error.resultContext : {
        runRoot: join(repoRoot, FILE_FINDING_ROOT, "runs", `finding-${randomUUID()}`), requestedAssessor: requestedAssessor(repoRoot),
        envelope: parseOutcomeEnvelope(args.delivery === undefined
          ? JSON.parse(readFileSync(resolve(repoRoot, args.candidate!), "utf8"))
          : verifyFindingDelivery(repoRoot, readFindingDelivery(resolve(repoRoot, args.delivery), args.repository), localDeliveryGit(input.runGit ?? runCredentialCleanGit))),
      };
      const cause = error instanceof FileFindingRunError ? error.cause : error;
      const busy = cause instanceof ExecutionClaimRefusedError && cause.reason === "live_holder";
      const fixingCommand = cause instanceof ExecutionClaimRefusedError && cause.reason === "undiagnosable"
        ? `Confirm no intake run is live, then manually remove the claim directory: Remove-Item -LiteralPath '${cause.lockPath.replaceAll("'", "''")}' -Recurse.`
        : cause instanceof ExecutionClaimRefusedError && cause.reason === "unverifiable_holder"
          ? "Confirm the holder this refusal names is not a live intake run, stop it or restart that host, then rerun the filing command."
        : busy ? "Wait for the live intake run to finish, then rerun the filing command."
          : fileFindingFixingCommand(reason, args, context.runRoot);
      const infrastructureNotes = "infrastructureNotes" in context ? context.infrastructureNotes : undefined;
      const infrastructure = (infrastructureNotes?.length ?? 0) > 0 || /^(assessor_unavailable|credential_unreadable):/.test(reason)
        || cause instanceof Error && ["ExecutionOwnershipError", "JournalWriteError"].includes(cause.name)
        || hasGitHubRequestStatus(cause) && (cause.status === null || [401, 403, 429].includes(cause.status) || cause.status >= 500);
      const result: FileFindingResult = { schemaVersion: 1, runRoot: context.runRoot, requestedAssessor: context.requestedAssessor,
        metrics: context.metrics ?? { durationsMs: {}, githubReads: { canonical: 0, intake: 0 } },
        status: busy ? "busy" : infrastructure ? "infrastructure" : args.execute ? "completed" : "dry-run",
        ...(infrastructureNotes?.length ? { infrastructureNotes } : {}),
        candidates: context.envelope.candidates.map(candidate => context.completed?.find(result => result.sourceFingerprint === candidate.sourceFingerprint)
          ?? ({ sourceFingerprint: candidate.sourceFingerprint,
          stableOutcomeId: candidate.stableOutcomeId, disposition: busy || infrastructure ? "interrupted" : "refused",
          reason, fixingCommand })),
      };
      assertRoadmapArtifactOutputPath(join(result.runRoot, "result.json"), repoRoot);
      publishResult(result, args, repoRoot, input.log ?? console.log);
      return fileFindingExitCode(result);
    } catch (reportError) {
      console.error(`${reason}\nFix: inspect the supplied candidate/delivery and requested stack descriptor before retrying.\n${reportError instanceof Error ? reportError.message : String(reportError)}`);
      return reportError instanceof FileFindingPublicationError ? 4 : 1;
    }
  }
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  void runFileFindingCommand({ argv: process.argv.slice(2), operatorToken: process.env.ROADMAP_SHADOW_PUBLISH_TOKEN })
    .then((exitCode) => { process.exitCode = exitCode; });
}
