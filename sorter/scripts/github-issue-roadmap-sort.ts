import { stewardshipRankKey, stewardshipScore } from "./lib/github-issue-roadmap/stewardship-rank-key";
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MessageChannel, Worker } from "node:worker_threads";
import { assertReadOnlyGhArgs } from "./github-issue-roadmap-preflight";
import { canonicalJsonSha256, sha256Bytes } from "./lib/github-issue-roadmap/canonical-json";
import { createStewardshipArtifactCache } from "./lib/github-issue-roadmap/stewardship-artifacts";
import { runCredentialCleanGit } from "./lib/github-issue-roadmap/credential-clean-git";
import { hostRepositoryLockPort } from "./lib/github-issue-roadmap/host-lock";
import { assessStewardshipIssue, STEWARDSHIP_SEAT_STARTUP_MS, validateStewardshipEvidence, type BoundStewardshipEvidence, type StewardshipSeat, type StewardshipReportIssueUsage } from "./lib/github-issue-roadmap/stewardship-assessment";
import { checkStewardshipAstraStartup } from "./lib/github-issue-roadmap/stewardship-astra-seat";
import { StewardshipAssessmentError, type StewardshipDiagnostic } from "./lib/github-issue-roadmap/stewardship-diagnostics";
import { compileStewardshipDecision, sameStewardshipSeatFamilies, STEWARDSHIP_COMPILER_VERSION, STEWARDSHIP_PRODUCTION_SEAT_FAMILIES, stewardshipDecisionProvenance,
  type DivergenceKey } from "./lib/github-issue-roadmap/stewardship-decision";
import { collectStewardshipEvidence, emptyStewardshipGitHubRequests, parseStewardshipTreeBlobs, stewardshipSourceSnippetIdentity, type StewardshipGitHubRequests, type StewardshipGitHubRequestFailure, type CollectStewardshipEvidenceOptions, type StewardshipEvidenceGeneration, type StewardshipTargetGeneration, type StewardshipIssueEvidencePacket } from "./lib/github-issue-roadmap/stewardship-evidence";
import { executeStewardshipSnapshot, executeStewardshipDecisions, isLegacyCompilerAction, recoverStewardshipActions, stewardshipRecoveryCandidates, stewardshipUnresolvedActionReason, type StewardshipExecutionRequest, type StewardshipExecutionResult } from "./lib/github-issue-roadmap/stewardship-executor";
import { createStewardshipGitHub, createStewardshipRehearsalTransport, type StewardshipGitHub, type StewardshipObservation } from "./lib/github-issue-roadmap/stewardship-github";
import { runStewardshipRehearsal } from "./lib/github-issue-roadmap/stewardship-rehearsal";
import { StewardshipTimingCollector, stewardshipTimingSummary, type StewardshipPhaseTiming, type StewardshipRateLimits } from "./lib/github-issue-roadmap/stewardship-phase-timing";
import { createStewardshipPolicy, knownStewardshipPolicy, isSnapshotStewardshipPolicy, resolveStewardshipPolicy, STEWARDSHIP_NATIVE_FIELDS, stewardshipPolicySha256, validateStewardshipPolicyUpgrade, validateStewardshipPolicyChange, type StewardshipNativeField, type StewardshipPolicy } from "./lib/github-issue-roadmap/stewardship-policy";
import { createProductionStewardshipSeats } from "./lib/github-issue-roadmap/stewardship-seats";
import { validateGlmCredentialSlot } from "./lib/github-issue-roadmap/sweep-seats";
import { stewardshipPhaseBTrigger, type StewardshipCompileContext } from "./lib/github-issue-roadmap/stewardship-assessment";
import { nominateStewardshipScoutExcerpts, SCOUT_MIN_TIMEOUT_MS } from "./lib/github-issue-roadmap/stewardship-scout";
import { StewardshipUsageLimitError } from "./lib/github-issue-roadmap/stewardship-seat-process";
import type { StewardshipIssueUsage } from "./lib/github-issue-roadmap/stewardship-state";
import { buildStewardshipProjection, stewardshipAssessmentCurrencyKey, stewardshipAssessmentProtocolReceipt, stewardshipDecisionAssessmentProtocolsCurrent, stewardshipProjectionCovered, stewardshipProjectionRecaptures } from "./lib/github-issue-roadmap/stewardship-projection";
import { latestEvidenceRecorded, reuseStewardshipObservation, type StewardshipObservationAdmission } from "./lib/github-issue-roadmap/stewardship-observation-reuse";
import { compileStewardshipBacklog, stewardshipFilingFieldReceiptExportSchema } from "./lib/github-issue-roadmap/stewardship-backlog";
import type { StewardshipObservationReuseRecord } from "./lib/github-issue-roadmap/stewardship-backlog";
import { createStewardshipPreviewStore, acquireStewardshipStore, isReuseCapableCompileInput, readStewardshipControlPolicy, readStewardshipLifecycleReceipts, readStewardshipState, setStewardshipPaused, stewardshipHeldSnapshot, stewardshipPaths, type StewardshipEvent, type StewardshipState, type StewardshipStore } from "./lib/github-issue-roadmap/stewardship-state";

const REPOSITORY = "example-org/example-repo";
const FIELDS = STEWARDSHIP_NATIVE_FIELDS;
const SNAPSHOT_EVIDENCE_CHUNK_SIZE = 12;
const OBSERVATION_RECAPTURE_REQUEST_BUDGET = 3000;
const OBSERVATION_RECAPTURE_BATCH_REQUESTS = 18;
const OBSERVATION_RECAPTURE_ISSUE_REQUESTS = 11;
const OBSERVATION_RECAPTURE_LINKED_PR_REQUESTS = 2;
const OBSERVATION_RECAPTURE_DEFAULT_PR_COUNT = 2;
function backupSnapshotJournal(journal: string, at: string): void {
  const bytes = readFileSync(journal);
  if (bytes.toString("utf8").trim().split("\n").some((line) => JSON.parse(line).event.type === "snapshot-plan")) return;
  if (readdirSync(dirname(journal)).some((name) => /^journal\.backup-.*\.jsonl$/.test(name))) return;
  const stamp = new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const backup = join(dirname(journal), `journal.backup-${stamp}.jsonl`);
  copyFileSync(journal, backup, constants.COPYFILE_EXCL);
  try {
    if (statSync(backup).size !== bytes.byteLength) throw new Error("Snapshot journal backup length mismatch");
    if (sha256Bytes(readFileSync(backup)) !== sha256Bytes(bytes)) throw new Error("Snapshot journal backup sha256 mismatch");
  } catch (error) {
    try { rmSync(backup); }
    catch (cause) { throw new Error(`Snapshot journal backup cleanup failed: ${backup}`, { cause }); }
    throw error;
  }
}
type Command = "init" | "preview" | "shadow" | "approve" | "rehearse" | "run" | "status" | "pause" | "resume" | "release" | "pin" | "delivery" | "policy-update" | "policy-upgrade" | "seat-preflight" | "lifecycle-receipts";
interface Arguments { command: Command; glmSlot: string; snapshotSha256?: string; preflightConcurrency?: 1 | 2; injectTransient?: ("preflight" | "fence" | "readback")[]; scheduled: boolean; runAssembly?: boolean; issue?: number; field?: StewardshipNativeField; report?: string; outcome?: "delivered" | "failed"; filingFieldReceiptsPath?: string; out?: string; receiptsSchema?: "v1" | "v2" }
type Backlog = ReturnType<typeof compileStewardshipBacklog>;
type CompileInput = Parameters<typeof compileStewardshipBacklog>[0];
interface DecisionNeeded { issueNumber: number; title: string; seats: { family: string; unresolvedChoices: string[] }[]; question: string }
interface Report {
  snapshotPlan?: import("./lib/github-issue-roadmap/stewardship-executor").StewardshipSnapshotExecutionSummary;
  phaseTiming?: StewardshipPhaseTiming;
  rateLimits?: StewardshipRateLimits;
  mainDrift?: StewardshipEvidenceGeneration["mainDrift"];
  githubRequests?: StewardshipGitHubRequests;
  githubRequestFailures?: StewardshipGitHubRequestFailure[];
  githubRequestFailuresDropped?: number;
  censusSha256?: string;
  observationReuse?: StewardshipObservationReuseRecord;
  consecutiveDeferredCompiles?: number;
  heldSnapshot?: { waiting: true; snapshotSha256: string; ageMs: number | null };
  skippedUnchangedIssueNumbers?: number[];
  interventions?: StewardshipState["interventions"];
  backlog?: ReturnType<typeof compileStewardshipBacklog>;
  schemaVersion: "github-issue-roadmap-sort-report/v2"; runId: string; mode: "run" | "preview" | "shadow";
  now: Backlog["report"]["now"]; enteredNow: Backlog["report"]["enteredNow"]; leftNow: Backlog["report"]["leftNow"];
  unranked: number[]; abstained: number[]; escalated: number[]; lifecycleFlags: (Backlog["report"]["flags"][number] & { action: "set" | "held" | "cleared" | "without_receipt" })[];
  skippedBlocked: Backlog["report"]["skippedBlocked"]; pinsHonored: Backlog["report"]["pinsHonored"]; disagreements: Backlog["report"]["disagreements"];
  needsProductDecision: { unresolvedProductChoice: DecisionNeeded[]; premiseRequiresRescoping: number[]; alreadyCompleteRequiresLifecycleReview: number[] };
  priorityClearCandidates: { count: number; entries: Backlog["report"]["priorityClearCandidates"]["entries"] };
  stopReason: string;
  /** Absent means 1, preserving the historical serial report and journal bytes. */
  issueConcurrency?: number;
  startedAt: string; finishedAt: string; status: "updated" | "partial" | "nochange" | "escalated" | "stopped_usage_limit";
  usage: { issueNumber: number; usage: StewardshipReportIssueUsage }[];
  unassessedIssueNumbers?: number[];
  diagnostics?: readonly (StewardshipDiagnostic | { seat: null; stage: "evidence"; code: "currency_without_update"; field: "$"; issueNumber: number })[];
  /** Evidence collector's closed error code when a cycle failed closed in collection; never its message. */
  evidenceFailure?: "mixed_generation" | "read_exhausted" | "invalid_evidence" | "stale_pin";
  evidenceFailureCause?: "deadline" | "after_deadline" | "rate_limited" | "forbidden" | "transport";
  /** Archived Astra assessments the current assessment protocol makes non-current (absent when none). */
  astraAssessmentsNotCurrent?: { issues: number; assessments: number };
  summary: string; outcomes: StewardshipExecutionResult[]; assessedIssueNumbers: number[]; deferred: { issueNumber: number; reason: string; diagnostics?: readonly StewardshipDiagnostic[];
    assessments?: readonly { seat: StewardshipSeat["family"]; sha256: string }[] }[];
  proposals: { issueNumber: number; before: { Priority: string | null; Horizon: string | null }; operations: StewardshipExecutionRequest["decision"]["operations"]; rationale: string }[];
  concerns: { issueNumber: number; differingKeys: readonly DivergenceKey[]; clauseCount: number; concernReasons?: readonly string[] }[];
  coverage: { census: number | null; remaining: number | null; notes?: string[] } & Partial<ReturnType<typeof buildStewardshipProjection>["coverage"]>; holds: { issueNumber: number; field: StewardshipNativeField; kind: string }[];
  unresolvedActionIds: string[]; nextEligibleAt: string; continuationAt: string | null; retryNotBefore?: string | null; failure: string | null;
}
interface Dependencies {
  rehearsalBudget?: () => Promise<StewardshipRateLimits>;
  /** A fresh collector per invocation; null disables telemetry for equivalence checks. */
  phaseTiming?: StewardshipTimingCollector | null;
  /** In-process test seam only; the production entry point never supplies it. */
  hostLockPort?: number;
  /** In-process test seam only; bounded by the production evidence chunk size. */
  approveChunkSize?: number;
  /** In-process test seam only; bounded by the policy's nowSlots + nonNowSlots. */
  targetSlotLimit?: number;
  filingFieldReceiptsPath?: string;
  backlogContext?: Pick<Parameters<typeof compileStewardshipBacklog>[0], "previous" | "hasLiveSnapshot" | "firstApprovedCycleCompleted">;
  scout?: typeof nominateStewardshipScoutExcerpts;
  compileContextByIssue?: Readonly<Record<number, StewardshipCompileContext>>;
  root?: string; policy?: StewardshipPolicy; repoRoot?: string; now?: () => string; sleep?: (ms: number) => Promise<void>;
  collect?: typeof collectStewardshipEvidence;
  runGit?: CollectStewardshipEvidenceOptions["runGit"];
  seats?: readonly StewardshipSeat[]; createGitHub?: () => StewardshipGitHub;
  checkAstraStartup?: typeof checkStewardshipAstraStartup;
  assertCheckout?: () => void; token?: () => string;
}
function parseArguments(args: readonly string[]): Arguments {
  const command = args[0];
  if (!["init", "preview", "shadow", "approve", "rehearse", "run", "status", "pause", "resume", "release", "pin", "delivery", "policy-update", "policy-upgrade", "seat-preflight", "lifecycle-receipts"].includes(command)) throw new Error("Expected a roadmap sort command");
  const parsed: Arguments = { command: command as Command, glmSlot: "primary", scheduled: false }; const seen = new Set<string>();
  if (command === "approve") {
    if (!/^[a-f0-9]{64}$/.test(args[1] ?? "")) throw new Error("Approval requires a snapshot sha");
    parsed.snapshotSha256 = args[1];
  }
  for (const arg of args.slice(command === "approve" ? 2 : 1)) {
    const [key, ...parts] = arg.split("="); const value = parts.join("=");
    if (seen.has(key) && !(command === "rehearse" && key === "--inject-transient")) throw new Error("Duplicate option"); seen.add(key);
    if (arg === "--scheduled" && command === "run") parsed.scheduled = true;
    else if (arg === "--run-assembly" && command === "preview") parsed.runAssembly = true;
    else if (key === "--glm-slot") parsed.glmSlot = validateGlmCredentialSlot(value);
    else if (key === "--snapshot" && command === "rehearse" && /^[a-f0-9]{64}$/.test(value)) parsed.snapshotSha256 = value;
    else if (key === "--preflight-concurrency" && command === "rehearse" && ["1", "2"].includes(value)) parsed.preflightConcurrency = Number(value) as 1 | 2;
    else if (key === "--inject-transient" && command === "rehearse" && ["preflight", "fence", "readback"].includes(value)) {
      (parsed.injectTransient ??= []).push(value as "preflight" | "fence" | "readback");
    }
    else if (key === "--out" && command === "lifecycle-receipts" && value) parsed.out = value;
    else if (key === "--schema" && command === "lifecycle-receipts" && ["v1", "v2"].includes(value)) parsed.receiptsSchema = value as "v1" | "v2";
    else if (key === "--filing-field-receipts" && ["preview", "shadow", "run"].includes(command) && value) parsed.filingFieldReceiptsPath = value;
    else if (key === "--issue" && ["release", "pin"].includes(command) && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) parsed.issue = Number(value);
    else if (key === "--field" && ["release", "pin"].includes(command)) {
      if (value === "Lifecycle") throw new Error("Lifecycle cannot be pinned or released; --field must be Horizon, Effort or Priority");
      if (!["Horizon", "Effort", "Priority"].includes(value)) throw new Error("--field must be Horizon, Effort or Priority");
      parsed.field = value as StewardshipNativeField;
    }
    else if (key === "--report" && command === "delivery" && /^[a-f0-9]{64}$/.test(value)) parsed.report = value;
    else if (key === "--outcome" && command === "delivery" && ["delivered", "failed"].includes(value)) parsed.outcome = value as Arguments["outcome"];
    else throw new Error("Unknown option or invalid option value");
  }
  if (["release", "pin"].includes(command) && (!parsed.issue || !parsed.field)) throw new Error("Issue and field required");
  if (command === "delivery" && (!parsed.report || !parsed.outcome)) throw new Error("Report and outcome required");
  if (command === "rehearse" && !parsed.snapshotSha256) throw new Error("Rehearsal requires --snapshot=<64 lowercase hex>");
  if (command === "lifecycle-receipts" && !parsed.out) throw new Error("Lifecycle receipts require --out=<path>");
  return parsed;
}

/** Local civil 09:15 in New York; computing each day's offset handles DST and missed runs. */
function dailyWindow(at: string): { previous: string; next: string } {
  const clock = Date.parse(at); const formatter = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  const parts = Object.fromEntries(formatter.formatToParts(clock).map((part) => [part.type, part.value]));
  const midnight = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  const candidates = [-1, 0, 1, 2].map((offset) => {
    const noon = midnight + offset * 86_400_000 + 12 * 3_600_000;
    const hour = Number(formatter.formatToParts(noon).find((part) => part.type === "hour")!.value);
    return noon + (9 - hour) * 3_600_000 + 15 * 60_000;
  });
  return { previous: new Date(Math.max(...candidates.filter((value) => value <= clock))).toISOString(), next: new Date(Math.min(...candidates.filter((value) => value > clock))).toISOString() };
}
function assertCheckout(repoRoot: string): void {
  const git = (args: readonly string[]) => runCredentialCleanGit(repoRoot, args, { localObjectsOnly: true });
  if (git(["remote", "get-url", "origin"]) !== "https://github.com/example-org/example-repo.git") throw new Error("Exact repository origin required");
  if (git(["status", "--porcelain", "--untracked-files=all"])) throw new Error("Clean trusted checkout required");
  git(["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
}
function bound(generation: StewardshipEvidenceGeneration, packet: StewardshipIssueEvidencePacket): BoundStewardshipEvidence {
  return { packet, originMainSha: generation.originMainSha, policySha256: generation.policySha256 };
}
function archiveEvidence(store: StewardshipStore, evidence: BoundStewardshipEvidence, at: string): void {
  const packetSha256 = store.archive(evidence.packet);
  store.append({ type: "evidence-recorded", issueNumber: evidence.packet.issueNumber, materialEvidenceSha256: evidence.packet.materialEvidenceSha256, packetSha256, originMainSha: evidence.originMainSha, policySha256: evidence.policySha256 }, at);
}
function observeFields(store: StewardshipStore, evidence: BoundStewardshipEvidence, policy: StewardshipPolicy, at: string): void {
  const packet = evidence.packet;
  for (const field of FIELDS) {
    const current = store.state.issues[packet.issueNumber].fields[field]; const history = packet.fieldHistory[field];
    if (!current || !history) continue;
    if (current.hold?.kind === "provenance" && current.provenanceBase && history.frontier.complete
      && (current.provenanceBase.frontier.eventIds.length === 0 || history.frontier.eventIds.some((id) => current.provenanceBase!.frontier.eventIds.includes(id)))) {
      const base = current.provenanceBase; const changes = history.events.filter((event) => !base.frontier.eventIds.includes(event.id));
      const attribution = changes.length === 0 && packet.fields[field] === base.value ? "none"
        : changes.length > 0 && changes.every((event) => event.actorLogin === policy.operator) ? "operator"
        : changes.length > 0 && changes.every((event) => event.actorLogin?.endsWith("[bot]")) ? "bot" : "unknown";
      store.append({ type: "field-history-recovered", issueNumber: packet.issueNumber, field, value: packet.fields[field] as typeof current.value,
        frontier: history.frontier, materialEvidenceSha256: packet.materialEvidenceSha256, historySha256: store.archive(history), attribution }, at);
      continue;
    }
    if (packet.fields[field] === current.value && canonicalJsonSha256(history.frontier) === canonicalJsonSha256(current.frontier)) continue;
    const added = history.events.filter((event) => !current.frontier.eventIds.includes(event.id));
    const actor = added.length > 0 && added.every((event) => event.actorLogin === policy.operator) ? "operator"
      : added.length > 0 && added.every((event) => event.actorLogin?.endsWith("[bot]")) ? "bot" : "unknown";
    store.append({ type: "field-observed", issueNumber: packet.issueNumber, field, value: packet.fields[field] as typeof current.value, frontier: history.frontier,
      materialEvidenceSha256: packet.materialEvidenceSha256, actor }, at);
  }
}
function holdContext(store: StewardshipStore, number: number, policy: StewardshipPolicy) {
  const issue = store.state.issues[number]; const heldEvidence: Record<string, BoundStewardshipEvidence> = {};
  for (const field of FIELDS) {
    const hold = issue.fields[field]?.hold; const reference = hold && issue.evidencePackets?.[hold.materialEvidenceSha256];
    if (hold && reference) {
      const evidence = { packet: store.readArtifact(reference.packetSha256) as StewardshipIssueEvidencePacket,
        originMainSha: reference.originMainSha, policySha256: reference.policySha256 };
      validateStewardshipEvidence(evidence, resolveStewardshipPolicy(reference.policySha256, policy));
      heldEvidence[hold.materialEvidenceSha256] = evidence;
    }
  }
  return { holds: { Priority: issue.fields.Priority.hold, Horizon: issue.fields.Horizon.hold }, heldEvidence,
    releasedAt: { Priority: issue.fields.Priority.releasedAt, Horizon: issue.fields.Horizon.releasedAt } };
}
function observationReportFields(report: Partial<Report>) {
  return { ...(report.observationReuse === undefined ? {} : { observationReuse: report.observationReuse }),
    ...(report.consecutiveDeferredCompiles === undefined ? {} : { consecutiveDeferredCompiles: report.consecutiveDeferredCompiles }) };
}
function pendingReports(store: Pick<StewardshipStore, "state" | "readArtifact">) {
  const state = store.state;
  return Object.values(state.runs).flatMap((run) => {
    if (!run.resultSha256 || state.deliveries?.[run.resultSha256]?.outcome === "delivered") return [];
    const report = store.readArtifact(run.resultSha256) as Report;
    return [{ reportId: run.resultSha256, summary: report.summary, ...observationReportFields(report) }];
  });
}
function eligibility(state: StewardshipState, readArtifact: (sha: string) => unknown, at: string) {
  const runs = Object.entries(state.runs).filter(([, run]) => run.mode !== "preview" && run.mode !== "shadow"
    && (!run.resultSha256 || run.assessmentCalls > 0 || run.remoteMutations > 0
      || !["approval_required", "shadow_pending_approval", "invalid_filing_field_receipts"].includes((readArtifact(run.resultSha256) as Report).stopReason)))
    .sort(([, a], [, b]) => b.startedAt.localeCompare(a.startedAt));
  const latest = runs[0];
  const cooldown = latest ? Date.parse(latest[1].startedAt) + 3_600_000 : 0;
  const completed = runs.find(([, run]) => run.resultSha256);
  const previous = completed?.[1].resultSha256 ? readArtifact(completed[1].resultSha256) as Report : null;
  const unfinished = Object.values(state.runs).some((run) => !run.resultSha256);
  const due = !latest || Date.parse(latest[1].startedAt) < Date.parse(dailyWindow(at).previous)
    || (previous?.continuationAt != null && Date.parse(previous.continuationAt) <= Date.parse(at));
  const retryFloor = previous?.retryNotBefore ? Date.parse(previous.retryNotBefore) : 0;
  const notBefore = Math.max(cooldown, retryFloor);
  return { runDue: (unfinished || (!state.paused && Date.parse(at) >= cooldown && due)) && Date.parse(at) >= retryFloor,
    cooldown: notBefore, scheduledDue: due, retryNotBefore: previous?.retryNotBefore ?? null,
    nextEligibleAt: new Date(Math.max(notBefore, Date.parse(previous?.nextEligibleAt ?? dailyWindow(at).next))).toISOString() };
}
function reportReason(reason: string): string {
  const words: Record<string, string> = {
    formula: "formula", blocker: "blocker", tooling: "tooling", emergency: "emergency", incumbent: "kept its Now place",
    pinned: "pinned", legacy_now_unranked: "existing Now issue awaiting ranking", closed: "issue closed", left_now: "left Now",
    both_seats_done_stale: "both seats consider it done or stale", tier_not_v1: "outside the milestone", new_blocker: "a new blocker",
    displaced_by_emergency: "displaced by an emergency", displaced_by_pin: "displaced by a pin",
    displaced_by_tooling: "displaced by tooling", displaced_by_blocker: "displaced by a milestone blocker",
    no_filing_receipt: "no filing receipt", filing_receipt_without_event_id: "filing receipt has no event ID",
    priority_clear_existing_cohort: "existing issue; coordinator review required", priority_clear_first_cycle: "first approved cycle must finish before clearing",
    priority_clear_needs_code: "code evidence is required before clearing", priority_clear_needs_demotion: "P0 or P1 lacks counterevidence for a clear",
    priority_clear_filing_stamp: "verified filing stamp", operator_move: "operator moved it out of Now", native_blocker: "blocked by an open issue",
    tier_claim_removed: "its milestone tier no longer warrants Now", severity_claim_removed: "its emergency severity no longer warrants Now",
    uncovered_keep_horizon: "assessment missing; current Horizon retained", exited_tier_needs_evidence: "milestone tier needs new evidence",
    effort_owned_elsewhere: "Effort was set by another writer", writer: "Effort belongs to",
    lifecycle_agreed_flag: "both seats agree on the flag", lifecycle_without_receipt: "flag has no receipt", lifecycle_hold: "Lifecycle evidence does not permit a change",
    lifecycle_history_incomplete: "Lifecycle or reopen history is incomplete", lifecycle_pin: "Horizon or Effort is pinned",
    lifecycle_agreed_p0: "both seats found a P0 emergency", lifecycle_contrary: "current evidence contradicts the flag", reopened_after_flag: "issue reopened after the flag",
    seats_disagreed: "seats disagree", approval_required: "approval required", coverage_incomplete: "assessment coverage is incomplete",
    shadow_only: "assessment coverage is incomplete", refused: "compile refused", call_budget_exhausted: "assessment call budget exhausted",
    admission_closed: "assessment window closed",
    stopped_usage_limit: "usage limit reached", completed: "completed", preview_only: "preview only",
    invalid_filing_field_receipts: "invalid filing field receipts; no changes written", cycle_failed_closed: "cycle stopped after a validation or execution failure",
    projection_census_changed: "census changed during projection capture", projection_main_changed: "main changed during projection capture",
    lifecycle_receipts_unavailable: "Lifecycle receipts unavailable",
  };
  const [code, detail] = reason.split(":", 2);
  if (detail && (code === "shadow_only" || code === "refused")) return `${words[code]}: ${reportReason(detail)}`;
  return `${words[code] ?? code.replaceAll("_", " ")}${detail ? /^\d+$/.test(detail) ? ` (#${detail})` : ` ${detail.replaceAll("_", " ")}` : ""}`;
}
function renderGlmCalls(report: Report): string {
  const slots = new Map<string, StewardshipReportIssueUsage["seats"]>();
  for (const { usage } of report.usage) for (const call of usage.seats) {
    if (call.seat !== "glm" || call.slot === undefined || call.outcome === undefined || call.wallMs === undefined) continue;
    const calls = slots.get(call.slot) ?? []; calls.push(call); slots.set(call.slot, calls);
  }
  return [...slots].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([slot, calls]) => {
    const outcomes = (["ok", "timeout", "rate_limited", "quota", "credential_unavailable", "error"] as const).map((outcome) => {
      const times = calls.filter((call) => call.outcome === outcome).map((call) => call.wallMs!).sort((a, b) => a - b);
      const middle = Math.floor(times.length / 2);
      const median = times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2;
      return `${times.length} ${outcome}${times.length ? ` (median ${median} ms)` : ""}`;
    });
    return `GLM calls (slot ${slot}): ${outcomes.join(", ")}\n`;
  }).join("");
}
function renderReportSections(report: Report, store: StewardshipStore): string {
  const input = report.backlog?.inputs as CompileInput | undefined;
  const state = store.state;
  const issueLabel = (number: number) => {
    const projected = input?.projection.issues[number];
    const reference = Object.values(state.issues[number]?.evidencePackets ?? {}).at(-1);
    const packet = input?.observations?.[number]?.evidence.packet
      ?? (projected?.assessment ? store.readArtifact(projected.assessment.packetSha256) as StewardshipIssueEvidencePacket
        : reference ? store.readArtifact(reference.packetSha256) as StewardshipIssueEvidencePacket : undefined);
    return `#${number}${packet?.title ? ` ${packet.title}` : ""}`;
  };
  const issueNumbers = (numbers: readonly number[]) => numbers.map((number) => `#${number}`).join(", ") || "none";
  const ranked = (entry: Report["now"][number]) => {
    const step = input?.projection.issues[entry.issueNumber]?.assessment?.ranking.milestoneStep;
    return `${issueLabel(entry.issueNumber)} — ${reportReason(entry.reason)}${step?.status === "merged" ? ` (step ${step.value})` : ""}, score ${entry.score ?? "not assessed"}`;
  };
  const section = (label: string, lines: readonly string[]) => `${label}:\n${lines.length ? lines.join("\n") : "none"}\n`;
  const tokenUsage = (seat: string, usage: StewardshipIssueUsage["scout"]) => `${seat}: ${!usage || usage === "unknown" ? "usage unknown"
    : `${usage.inputTokens} input (${usage.cachedInputTokens} cached), ${usage.outputTokens} output`}`;
  const decisions = report.needsProductDecision;
  const requests = report.githubRequests;
  return (report.issueConcurrency === undefined ? "" : `Issue concurrency: ${report.issueConcurrency}\n`)
    + (report.mainDrift ? `Main moved during this run: evidence pinned to ${report.mainDrift.pinnedSha}, GitHub main at ${report.mainDrift.remoteMainShaAtEnd} (${report.mainDrift.aheadBy} commits ahead)\n` : "")
    + (requests ? `GitHub requests: graphql ${requests.graphql.ok} ok/${requests.graphql.error} error; rest ${requests.rest.ok} ok/${requests.rest.error} error; other ${requests.other.ok} ok/${requests.other.error} error\n` : "")
    + (report.githubRequestFailures ?? []).map((failure) => `GitHub request failure: ${failure.kind} ${failure.operation ?? "none"}`
      + `${failure.cursorIndex === null ? "" : ` page ${failure.cursorIndex}`} (request ${failure.requestIndex}): ${failure.failureClass}, `
      + `exit ${failure.exitCode ?? "none"}, http ${failure.httpStatus ?? "none"}, graphql errors ${failure.graphqlErrorTypes.join(", ") || "none"}, hint ${failure.networkHint}\n`).join("")
    + (report.githubRequestFailuresDropped ? `GitHub request failures not recorded: ${report.githubRequestFailuresDropped}\n` : "")
    + report.outcomes.flatMap((outcome) => (outcome.unresolvedSendReceipts ?? []).map(({ actionId, operationIndex, receipt }) =>
      `Unresolved send: #${outcome.issueNumber} op ${operationIndex} (${actionId}): http ${receipt.httpStatus}, request ${receipt.requestId ?? "none"}, `
      + `body bytes ${receipt.responseBodyBytes ?? "unknown"}, sha256 ${receipt.responseBodySha256 ?? "unknown"}, target field value present ${receipt.targetFieldValuePresent ?? "unknown"}\n`)).join("")
    + (report.observationReuse ? `Observation reuse: ${report.observationReuse.reused} reused; ${report.observationReuse.recaptured} recaptured; ${report.observationReuse.deferred} deferred\n`
      + `Refused reuse reasons: ${Object.entries(report.observationReuse.refusalReasons).sort(([a], [b]) => a.localeCompare(b)).map(([reason, count]) => `${reason}: ${count}`).join(", ") || "none"}\n` : "")
    + (report.consecutiveDeferredCompiles === undefined ? "" : `Consecutive deferred compiles: ${report.consecutiveDeferredCompiles}\n`)
    + (report.heldSnapshot ? `Held snapshot: waiting=${report.heldSnapshot.waiting}; sha=${report.heldSnapshot.snapshotSha256}; age=${report.heldSnapshot.ageMs ?? "unknown"} ms\n` : "")
    + renderGlmCalls(report)
    + (report.astraAssessmentsNotCurrent === undefined ? "" : `Astra assessments not current under the per-issue thread protocol: `
      + `${report.astraAssessmentsNotCurrent.assessments} across ${report.astraAssessmentsNotCurrent.issues} issues; they are re-assessed as they come up\n`)
    + section("Now (reason and score)", report.now.map(ranked))
    + section("Entered and left Now", [
      ...report.enteredNow.map((entry) => `${issueLabel(entry.issueNumber)} entered Now — ${reportReason(entry.reason)}`),
      ...report.leftNow.map((entry) => `${issueLabel(entry.issueNumber)} left Now — ${reportReason(entry.reason)}`),
    ])
    + section("Coverage, unranked, abstained and escalated", [
      `${report.coverage.covered ?? "unknown"} of ${report.coverage.total ?? report.coverage.census ?? "unknown"} covered; ${report.coverage.needsEvidence ?? "unknown"} need evidence; ${report.coverage.remaining ?? "unknown"} remaining`,
      `Unranked (${report.unranked.length}): ${issueNumbers(report.unranked)}`, `Abstained (${report.abstained.length}): ${issueNumbers(report.abstained)}`,
      `Escalated (${report.escalated.length}): ${issueNumbers(report.escalated)}`,
      ...[...new Set([...(report.coverage.notes ?? []), ...(report.backlog?.report.coverage.notes ?? [])])].map(reportReason),
    ])
    + section("Settled without GLM (local path in evidence)", (report.coverage.settledWithoutGlm ?? []).map((entry) => `#${entry.issueNumber} — Astra-only; no proposals`))
    + section("Lifecycle flags (set, held, cleared, without receipt)", report.lifecycleFlags.map((entry) => `${issueLabel(entry.issueNumber)} ${entry.action === "set"
      ? `set ${entry.lifecycle.value}` : entry.action === "without_receipt" ? "without receipt" : entry.action} (${reportReason(entry.lifecycle.reason)})`))
    + section("Skipped blocked candidates", report.skippedBlocked.map((entry) => `${issueLabel(entry.issueNumber)} — blocked by ${entry.blockers.map((blocker) => `${blocker.qualified} (${blocker.state?.toLowerCase() ?? "state unknown"})`).join(", ")}`))
    + section("Pins honored", report.pinsHonored.map((entry) => `${issueLabel(entry.issueNumber)} — ${entry.field} pinned to ${entry.value ?? "unset"} (${entry.source === "explicit" ? "explicit pin" : "operator change"})`))
    + section("Priority and Effort disagreements", report.disagreements.map((entry) => `${issueLabel(entry.issueNumber)} — ${entry.field}: current ${entry.current ?? "unset"}; ${entry.proposed === null ? "no agreed value" : `seats propose ${entry.proposed}`}; ${reportReason(entry.reason)}`))
    + section("Token usage per seat and scout (cached and uncached)", report.usage.flatMap((entry) => [
      ...entry.usage.seats.map((call) => `${issueLabel(entry.issueNumber)} — ${tokenUsage(call.seat, call.usage)} (${call.phase}, attempt ${call.attempt})`),
      ...(entry.usage.scout === undefined ? [] : [`${issueLabel(entry.issueNumber)} — ${tokenUsage("scout", entry.usage.scout)}`]),
    ]))
    + `Stop reason: ${reportReason(report.stopReason)}\n`
    + section("Needs a product decision", decisions.unresolvedProductChoice.map((entry, index) => `${index + 1}. ${entry.question}\n${entry.seats.map((seat) => `   ${seat.family}: ${(seat.unresolvedChoices.join("; ") || "no unresolved choices").replace(/\r?\n/g, "\n   ")}`).join("\n")}`))
    + section("Premise requires rescoping", decisions.premiseRequiresRescoping.map(issueLabel))
    + section("Already complete; requires Lifecycle review", decisions.alreadyCompleteRequiresLifecycleReview.map(issueLabel))
    + `Priority clear candidates (for the coordinator): ${report.priorityClearCandidates.count}\n`
    + (report.priorityClearCandidates.entries.map((entry) => `${issueLabel(entry.issueNumber)} — ${reportReason(entry.reason)} (${entry.current})`).join("\n") || "none") + "\n";
}
const SNAPSHOT_APPROVAL_MAX_AGE_MS = 7 * 86_400_000;
function pendingSnapshotAgeMs(location: Parameters<typeof stewardshipPaths>[0], pending: NonNullable<StewardshipState["pendingSnapshot"]>, at: string) {
  const journal = readFileSync(stewardshipPaths(location).journal, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { at: string; event: StewardshipEvent });
  const compiled = journal.findLast(({ event }) => event.type === "backlog-compiled"
    && event.snapshotSha256 === pending.snapshotSha256 && event.compileInputsSha256 === pending.compileInputsSha256);
  return compiled ? Date.parse(at) - Date.parse(compiled.at) : null;
}
function heldSnapshotReport(state: StewardshipState, readArtifact: (hash: string) => unknown,
  location: Parameters<typeof stewardshipPaths>[0], at: string): Report["heldSnapshot"] {
  const held = stewardshipHeldSnapshot(state, readArtifact);
  return held ? { waiting: true, snapshotSha256: held.snapshotSha256, ageMs: pendingSnapshotAgeMs(location, held, at) } : undefined;
}
function reuseApprovalHoldArmed(state: StewardshipState, readArtifact: (hash: string) => unknown) {
  return !Object.values(state.snapshots ?? {}).some((snapshot) => (snapshot.status === "completed"
    || (snapshot.status === "replacement-required" && snapshot.refusal?.reason === "completed-with-skips"))
    && isReuseCapableCompileInput(readArtifact, snapshot.compileInputsSha256));
}
function finish(store: StewardshipStore, report: Report, root?: string, preview = false, phaseTiming?: StewardshipTimingCollector) {
  const heldSnapshot = heldSnapshotReport(store.state, (hash) => store.readArtifact(hash), { root, repository: REPOSITORY }, report.finishedAt);
  if (heldSnapshot) {
    report.heldSnapshot = heldSnapshot;
    report.summary += ` Held snapshot ${heldSnapshot.snapshotSha256} waiting for approval; age ${heldSnapshot.ageMs} ms.`;
  }
  if (report.backlog) {
    const compiled = report.backlog.report;
    for (const key of ["now", "enteredNow", "leftNow", "unranked", "abstained", "escalated", "skippedBlocked", "pinsHonored", "disagreements"] as const) Object.assign(report, { [key]: structuredClone(compiled[key]) });
    report.lifecycleFlags = compiled.flags.map((flag) => ({ ...flag, action: flag.lifecycle.reason.includes("without_receipt") ? "without_receipt"
      : flag.lifecycle.disposition === "report_only" ? "held"
      : flag.lifecycle.value === flag.lifecycle.current ? "held" : flag.lifecycle.value === null ? "cleared" : "set" }));
    const entries = compiled.priorityClearCandidates.entries.filter((entry) => entry.disposition === "report_only");
    report.priorityClearCandidates = { count: entries.length, entries };
    const input = report.backlog.inputs as CompileInput;
    const rank = (number: number) => {
      const issue = input.projection.issues[number]; const ranking = issue.assessment?.ranking;
      const value = ranking?.value; const effort = ranking?.effort; const tier = ranking?.tier;
      return { tier: tier?.status === "merged" ? ["blocks_milestone", "v1_not_blocking", "not_v1"].indexOf(tier.value) : 3,
        effort: effort?.status === "merged" ? { low: 0, medium: 1, high: 2 }[effort.value] : 3,
        value: value?.status === "merged" ? value.value : -1,
        step: ranking?.milestoneStep.status === "merged" ? ranking.milestoneStep.value : Number.MAX_SAFE_INTEGER,
        score: stewardshipScore(value?.status === "merged" ? value.value : null, effort?.status === "merged" ? effort.value : null) ?? -1 };
    };
    const nowRank = new Map(compiled.now.map((entry, index) => [entry.issueNumber, index]));
    const rankOrder = (a: number, b: number) => {
      const left = rank(a); const right = rank(b);
      return (nowRank.get(a) ?? Number.MAX_SAFE_INTEGER) - (nowRank.get(b) ?? Number.MAX_SAFE_INTEGER)
        || left.tier - right.tier || (left.tier === 0 ? left.effort - right.effort || right.value - left.value : right.score - left.score)
        || left.effort - right.effort || left.step - right.step || a - b;
    };
    for (const number of Object.keys(input.projection.issues).map(Number).sort(rankOrder)) {
      const assessment = input.projection.issues[number].assessment;
      if (!assessment) continue;
      const seats = assessment.assessments.map((envelope) => ({ family: envelope.seat.family, unresolvedChoices: [...envelope.assessment.unresolvedChoices] })).sort((a, b) => a.family.localeCompare(b.family));
      const stateIssue = store.state.issues[number];
      const pairHashes = assessment.assessments.map(canonicalJsonSha256).sort();
      const recorded = [...(stateIssue?.assessmentHistory ?? []), ...(stateIssue?.assessment ? [stateIssue.assessment] : [])].reverse()
        .map((entry) => store.readArtifact(entry.decisionSha256) as { reasons: string[]; assessmentSha256s: string[] });
      const reasons = recorded.find((decision) => canonicalJsonSha256([...decision.assessmentSha256s].sort()) === canonicalJsonSha256(pairHashes))?.reasons ?? [];
      if (reasons.some((reason) => ["unresolved_product_choice", "premise_requires_rescoping", "already_complete_requires_lifecycle_review"].includes(reason))
        && !report.escalated.includes(number)) report.escalated.push(number);
      if (reasons.includes("unresolved_product_choice")) {
        const packet = store.readArtifact(assessment.packetSha256) as StewardshipIssueEvidencePacket;
        const choices = seats.flatMap((seat) => seat.unresolvedChoices).map((text) => text.trim().replace(/[.?!]+$/, "")).filter(Boolean);
        const first = choices[0]?.split("?")[0].trim();
        const question = first && /^(should|which|what|when|where|who|how|can|could|would|will|do|does|is|are)\b/i.test(first)
          ? `Before anyone builds #${number} (${packet.title}): ${first}?`
          : `Which of these should #${number} do: ${choices.map((choice) => choice.replaceAll("?", "")).join(" or ") || "resolve the product choice"}?`;
        report.needsProductDecision.unresolvedProductChoice.push({ issueNumber: number, title: packet.title, seats, question });
      }
      if (reasons.includes("premise_requires_rescoping")) report.needsProductDecision.premiseRequiresRescoping.push(number);
      if (reasons.includes("already_complete_requires_lifecycle_review")) report.needsProductDecision.alreadyCompleteRequiresLifecycleReview.push(number);
    }
  }
  report.stopReason = report.failure ?? (report.stopReason !== "completed" ? report.stopReason
    : report.deferred[0]?.reason ?? report.outcomes.find((outcome) => outcome.status === "partial" || outcome.status === "deferred")?.reasons[0] ?? "completed");
  if (phaseTiming) {
    try {
      const timing = phaseTiming.snapshot();
      const summary = stewardshipTimingSummary(timing);
      Object.assign(report, timing);
      report.summary += ` ${summary}`;
    } catch { /* Telemetry cannot prevent report archival. */ }
  }
  const reportId = store.archive(report);
  const path = join(stewardshipPaths({ root, repository: REPOSITORY }).artifacts, `${reportId}.txt`);
  const changes = report.proposals.map((proposal) => `#${proposal.issueNumber} (${proposal.before.Priority ?? "unset"}, ${proposal.before.Horizon ?? "Inbox"}): ${proposal.operations.map((operation) => `${operation.kind.replaceAll("_", " ")}${"value" in operation ? ` to ${operation.value}` : ""}`).join("; ") || "no proposed changes"}\n${proposal.rationale}`).join("\n");
  const diagnostics = [...(report.evidenceFailure ? [`host/evidence/${report.evidenceFailure}${report.evidenceFailureCause ? `/${report.evidenceFailureCause}` : ""} $`] : []),
    ...(report.diagnostics ?? []).map((item) => `${"issueNumber" in item ? `#${item.issueNumber}: ` : ""}${item.seat ?? "host"}/${item.stage}/${item.code} ${item.field}${"method" in item && item.method ? ` method=${item.method}` : ""}`),
    ...report.deferred.flatMap((entry) => [
    ...(entry.diagnostics ?? []).map((item) => `#${entry.issueNumber}: ${item.seat ?? "host"}/${item.stage}/${item.code} ${item.field}${item.method ? ` method=${item.method}` : ""}`),
    ...(entry.assessments ?? []).map((item) => `#${entry.issueNumber}: ${item.seat} valid assessment archived at ${item.sha256}`),
  ])].join("\n");
  const concerns = report.concerns.map((entry) => `#${entry.issueNumber}: ${entry.differingKeys.join(", ")}; ${entry.clauseCount} differing clauses${entry.concernReasons ? `; ${entry.concernReasons.join(", ")}` : ""}`).join("\n");
  const backlog = report.backlog ? `Backlog compile: ${report.backlog.status} (${report.backlog.snapshotSha256})\n` : "";
  const interventions = (report.interventions ?? []).map((event) => `#${event.issueNumber}: ${event.field} write overwrote ${event.overwrittenValue ?? "unset"} during concurrent intervention (${event.nativeEventId}).`).join("\n");
  const sections = renderReportSections(report, store);
  const plan = report.snapshotPlan;
  const snapshotSummary = plan ? `Snapshot plan: ${plan.thresholdNumerator}/${plan.thresholdDenominator} direct skips; ${plan.issueCount} issues; partialStop=${plan.partialStop}; ${plan.propagatedSkips} propagated skips; ${plan.sendSkips} send-phase skips; ${plan.outages} outages; ${plan.notApplied} not-applied.\n`
    + report.outcomes.flatMap((outcome) => outcome.snapshot ? [`#${outcome.issueNumber}: direct [${outcome.snapshot.directSkippedIndices.join(", ")}]; propagated [${outcome.snapshot.propagatedSkippedIndices.join(", ")}]; send-phase [${outcome.snapshot.sendSkippedIndices.join(", ")}]; outages [${outcome.snapshot.outageIndices.join(", ")}]; N [${outcome.snapshot.notAppliedIndices.join(", ")}]. ${outcome.snapshot.skips.map((skip) => `Op ${skip.index}: ${skip.reason}`).join("; ")}`] : []).join("\n") + "\n" : "";
  const text = `${report.summary}\n${snapshotSummary}${sections}${report.holds.length} field holds; ${report.unresolvedActionIds.length} unresolved effects.\n${changes}\n${diagnostics}\n${concerns ? `${concerns}\n` : ""}${interventions ? `${interventions}\n` : ""}${backlog}Report: ${reportId}\n`;
  if (preview) return { ...report, reportId, reportText: text, previewRun: store.state.runs[report.runId], delivery: "preview" as const };
  try { const file = openSync(path, "wx", 0o600); try { writeFileSync(file, text); fsyncSync(file); } finally { closeSync(file); } }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || readFileSync(path, "utf8") !== text) throw error; }
  store.append({ type: "run-finished", runId: report.runId, resultSha256: reportId }, report.finishedAt);
  return { ...report, reportId, reportTextFilename: `${reportId}.txt`, delivery: "pending" as const };
}
function baseReport(store: StewardshipStore, runId: string, at: string, mode: Report["mode"], identity: Pick<StewardshipPolicy, "repository" | "operator">,
  githubRequests?: StewardshipGitHubRequests, githubRequestFailures?: StewardshipGitHubRequestFailure[], githubRequestFailuresDropped = 0): Report {
  const state = store.state;
  const policy = resolveStewardshipPolicy(state.policySha256, identity);
  const issueConcurrency = "issueConcurrency" in policy.limits ? policy.limits.issueConcurrency : 1;
  return { ...(issueConcurrency > 1 ? { issueConcurrency } : {}), schemaVersion: "github-issue-roadmap-sort-report/v2", runId, mode, startedAt: state.runs[runId].startedAt, finishedAt: at,
    ...(githubRequests ? { githubRequests } : {}), ...(githubRequestFailures?.length ? { githubRequestFailures } : {}),
    ...(githubRequestFailuresDropped ? { githubRequestFailuresDropped } : {}), now: [], enteredNow: [], leftNow: [], unranked: [], abstained: [], escalated: [], lifecycleFlags: [], skippedBlocked: [], pinsHonored: [], disagreements: [],
    needsProductDecision: { unresolvedProductChoice: [], premiseRequiresRescoping: [], alreadyCompleteRequiresLifecycleReview: [] }, priorityClearCandidates: { count: 0, entries: [] }, stopReason: "completed",
    status: "partial", summary: "Roadmap cycle incomplete.", outcomes: [], assessedIssueNumbers: [], deferred: [], proposals: [], concerns: [], usage: [], coverage: { census: null, remaining: null },
    holds: Object.entries(state.issues).flatMap(([number, issue]) => FIELDS.flatMap((field) => issue.fields[field]?.hold ? [{ issueNumber: Number(number), field, kind: issue.fields[field]!.hold!.kind }] : [])),
    unresolvedActionIds: Object.entries(state.actions).filter(([, action]) => action.outcome === null || action.outcome === "unresolved" || action.outcome === "conflict").map(([id]) => id),
    nextEligibleAt: dailyWindow(at).next, continuationAt: null, failure: null };
}

async function assertRehearsalIdle(port: number): Promise<void> {
  await new Promise<void>((accept, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); reject(new Error("rehearsal_live_run_active")); });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy(); if (error.code === "ECONNREFUSED") accept(); else reject(error);
    });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("rehearsal_lock_probe_unavailable")); });
  });
}

/** Injection happens below collection, inside its existing bounded retry path. */
export function createRehearsalReadRunner(read: (args: readonly string[]) => string, inject: boolean, limited: () => void) {
  return (args: readonly string[]): string => {
    assertReadOnlyGhArgs(args);
    if (inject) {
      inject = false;
      throw Object.assign(new Error("Injected HTTP 503"), { status: 1,
        stdout: "HTTP/2.0 503 Service Unavailable\r\n\r\n{}", stderr: "HTTP 503" });
    }
    const check = (raw: string) => {
      if (/^HTTP\/\S+ 429\b|secondary rate limit|retry-after:/im.test(raw)) limited();
    };
    try { const output = read(args); check(output); return output; }
    catch (error) {
      const failure = error as { stdout?: unknown; stderr?: unknown };
      check(`${String(failure.stdout ?? "")}\n${String(failure.stderr ?? "")}`);
      throw error;
    }
  };
}

/** Synchronous collector I/O runs in isolated workers so lever (b) overlaps real chunks. */
function runCollectorWorker(input: {
  options: Omit<CollectStewardshipEvidenceOptions, "now" | "runGh" | "phaseTiming">;
  inject: boolean; signal?: AbortSignal;
  read: (argv: string[], done: (error: unknown, stdout: string, stderr: string) => void) => ChildProcess;
}, timing: StewardshipTimingCollector, counts: StewardshipGitHubRequests, failures: StewardshipGitHubRequestFailure[]): Promise<StewardshipEvidenceGeneration> {
  const directory = dirname(fileURLToPath(import.meta.url));
  return new Promise((accept, reject) => {
    const { signal, read, ...workerInput } = input;
    if (signal?.aborted) { reject(Object.assign(new Error("rehearsal_rate_limited"), { status: 429 })); return; }
    const channel = new MessageChannel();
    const signalBuffer = new SharedArrayBuffer(4);
    const wake = new Int32Array(signalBuffer);
    let child: ChildProcess | undefined;
    const worker = new Worker(`
      require(workerData.tsx);
      const { collectStewardshipEvidence, emptyStewardshipGitHubRequests, StewardshipEvidenceCollectionError } = require(workerData.evidence);
      const { StewardshipTimingCollector } = require(workerData.timing);
      const { createRehearsalReadRunner } = require(workerData.cli);
      const { receiveMessageOnPort } = require('node:worker_threads');
      const wake = new Int32Array(workerData.signalBuffer);
      let serial = 0;
      class Timing extends StewardshipTimingCollector {
        start(name, sync) { const id = ++serial; parentPort.postMessage({ type: 'start', id, name, sync });
          return () => parentPort.postMessage({ type: 'stop', id }); }
        retry(name = 'collect.retryWait') { parentPort.postMessage({ type: 'retry', name }); }
        response(status, header) { const headers = Object.fromEntries(
          ['x-ratelimit-resource', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-ratelimit-used', 'x-ratelimit-limit', 'retry-after'].map(name => [name, header(name)]));
          parentPort.postMessage({ type: 'response', status, headers }); }
      }
      const counts = emptyStewardshipGitHubRequests();
      const failures = [];
      let limited = false;
      const limitError = () => new StewardshipEvidenceCollectionError('read_exhausted', 1, 'rehearsal_rate_limited', null, 'rate_limited');
      const runGh = createRehearsalReadRunner((argv) => {
          if (limited) throw limitError();
          Atomics.store(wake, 0, 0);
          parentPort.postMessage({ type: 'gh', argv });
          Atomics.wait(wake, 0, 0);
          const reply = receiveMessageOnPort(workerData.readPort).message;
          if (reply.error) throw Object.assign(new Error('GitHub read failed'), reply.error);
          return reply.stdout;
      }, workerData.inject, () => { limited = true; throw limitError(); });
      try { const result = collectStewardshipEvidence({ ...workerData.options, now: () => new Date().toISOString(),
        runGh, phaseTiming: new Timing(), githubRequests: counts, githubRequestFailures: failures }); parentPort.postMessage({ type: limited ? 'limited' : 'result', result, counts, failures }); }
      catch (error) { parentPort.postMessage({ type: limited ? 'limited' : 'failure', code: error.code, cause: error.cause, counts, failures }); }
    `.replace(/^/, "const { parentPort, workerData } = require('node:worker_threads');\n"), {
      eval: true, transferList: [channel.port2], workerData: { ...workerInput, signalBuffer, readPort: channel.port2, tsx: resolve(directory, "../node_modules/tsx/dist/cjs/index.cjs"),
        evidence: join(directory, "lib/github-issue-roadmap/stewardship-evidence.ts"),
        timing: join(directory, "lib/github-issue-roadmap/stewardship-phase-timing.ts"), cli: join(directory, "github-issue-roadmap-sort.ts") },
    });
    const spans = new Map<number, () => void>();
    let settled = false;
    const abort = () => { if (!settled) { finish(); reject(Object.assign(new Error("rehearsal_rate_limited"), { status: 429 })); } };
    const finish = () => {
      settled = true; signal?.removeEventListener("abort", abort);
      // The parent owns the gh process, so terminating a blocked worker cannot orphan it.
      if (child?.pid && child.exitCode === null) {
        try {
          if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
          else process.kill(-child.pid, "SIGKILL");
        } catch { child.kill("SIGKILL"); }
      }
      channel.port1.close(); for (const stop of spans.values()) stop(); spans.clear(); void worker.terminate();
    };
    signal?.addEventListener("abort", abort, { once: true });
    worker.on("message", (message: { type: string; id: number; name: Parameters<StewardshipTimingCollector["start"]>[0]; sync: boolean;
      status: number; headers: Record<string, string | null>; argv: string[]; result: StewardshipEvidenceGeneration; counts: StewardshipGitHubRequests;
      failures: StewardshipGitHubRequestFailure[]; code?: string; cause?: string }) => {
      if (settled) return;
      if (message.type === "gh") {
        child = read(message.argv, (error, stdout, stderr) => {
          if (settled) return;
          const failure = error as { code?: string | number; signal?: string } | null;
          channel.port1.postMessage({ stdout, ...(error ? { error: { status: failure?.code, signal: failure?.signal, stdout, stderr } } : {}) });
          Atomics.store(wake, 0, 1); Atomics.notify(wake, 0);
        });
      }
      if (message.type === "start") spans.set(message.id, timing.start(message.name, message.sync));
      if (message.type === "stop") { spans.get(message.id)?.(); spans.delete(message.id); }
      if (message.type === "retry") timing.retry(message.name === "transport.retryWait" ? message.name : "collect.retryWait");
      if (message.type === "response") timing.response(message.status, (name) => new Map(Object.entries(message.headers)).get(name) ?? null);
      if (message.type === "result" || message.type === "failure" || message.type === "limited") {
        counts.rest.ok += message.counts.rest.ok; counts.rest.error += message.counts.rest.error;
        counts.graphql.ok += message.counts.graphql.ok; counts.graphql.error += message.counts.graphql.error;
        counts.other.ok += message.counts.other.ok; counts.other.error += message.counts.other.error;
        failures.push(...message.failures);
        finish();
        if (message.type === "result") accept(message.result);
        else if (message.type === "limited") reject(Object.assign(new Error("rehearsal_rate_limited"), { status: 429 }));
        else reject(Object.assign(new Error("rehearsal_collection_failed"), { code: message.code, cause: message.cause }));
      }
    });
    worker.on("error", (error) => { if (!settled) { finish(); reject(error); } });
    worker.on("exit", () => { if (!settled) { finish(); reject(new Error("rehearsal_worker_exited")); } });
  });
}

/** Single production composition, with transport/clock seams for offline integration proof. */
export async function runRoadmapSort(args: readonly string[], dependencies: Dependencies = {}): Promise<unknown> {
  if (args[0] === "--help" || (args[0] === "rehearse" && args[1] === "--help")) return {
    summary: "roadmap:sort -- rehearse --snapshot=<64 hex> [--preflight-concurrency=1|2] [--inject-transient=preflight|fence|readback] (repeatable). Last compile left 2536/5000 core REST. One rehearsal costs one live run's reads: at most one rehearsal per reset window alongside a compile. Refuses below 1500 core REST remaining. Live-run exclusion is checked once at start; a live run starting mid-rehearsal is not detected and its lock is unaffected. Operators must not start both at once. A crashed unfinished live run must be reconciled first.",
  };
  const cli = parseArguments(args);
  let runAssembly = cli.command === "run" || cli.runAssembly === true;
  if (cli.command === "seat-preflight") {
    const result = await (dependencies.checkAstraStartup ?? checkStewardshipAstraStartup)();
    return result.ok ? { status: "seat-preflight", ok: true } : { status: "seat-preflight", ok: false, failedCheck: result.failedCheck };
  }
  const now = dependencies.now ?? (() => new Date().toISOString());
  const githubRequests = emptyStewardshipGitHubRequests();
  const phaseTiming = dependencies.phaseTiming === null && cli.command !== "rehearse" ? undefined : dependencies.phaseTiming ?? new StewardshipTimingCollector();
  const githubRequestFailures: StewardshipGitHubRequestFailure[] = [];
  let githubRequestFailuresDropped = 0;
  const receiptsPath = cli.filingFieldReceiptsPath ?? dependencies.filingFieldReceiptsPath;
  let filingFieldReceipts: CompileInput["filingFieldReceipts"];
  let filingFieldReceiptsSha256: CompileInput["filingFieldReceiptsSha256"];
  let filingFieldReceiptsText: string | undefined;
  const loadFilingReceipts = () => {
    if (receiptsPath !== undefined) try {
      const bytes = readFileSync(receiptsPath);
      const text = bytes.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("Receipt must be UTF-8");
      const envelope = stewardshipFilingFieldReceiptExportSchema.parse(JSON.parse(text));
      if (envelope.repository.toLowerCase() !== REPOSITORY) throw new Error("Receipt repository mismatch");
      filingFieldReceipts = envelope.records.filter((receipt) => receipt.field === "Priority");
      filingFieldReceiptsSha256 = sha256Bytes(bytes);
      filingFieldReceiptsText = text;
    } catch { return false; }
    return true;
  };
  const policy = dependencies.policy ?? createStewardshipPolicy({ repository: REPOSITORY, operator: "example-user" });
  if (policy.repository !== REPOSITORY) throw new Error("Repository is fixed");
  const targetSlotLimit = dependencies.targetSlotLimit ?? policy.limits.nowSlots + policy.limits.nonNowSlots;
  if (!Number.isSafeInteger(targetSlotLimit) || targetSlotLimit < 1 || targetSlotLimit > policy.limits.nowSlots + policy.limits.nonNowSlots) {
    throw new Error(`targetSlotLimit must be a positive safe integer at most ${policy.limits.nowSlots + policy.limits.nonNowSlots}`);
  }
  const location = { artifactCache: createStewardshipArtifactCache(), root: dependencies.root, repository: REPOSITORY, policy, hostLockPort: dependencies.hostLockPort,
    allowPolicyMismatch: cli.command === "policy-update" || cli.command === "policy-upgrade" || cli.command === "status" };
  if (cli.command === "lifecycle-receipts") {
    const output = resolve(cli.out!);
    const withinStore = relative(stewardshipPaths(location).directory, output);
    if (!withinStore || (!isAbsolute(withinStore) && withinStore !== ".." && !withinStore.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))) throw new Error("Receipt output must be outside the stewardship store");
    const exported = await readStewardshipLifecycleReceipts({ ...location, generatedAt: now(), schema: cli.receiptsSchema });
    writeFileSync(output, `${JSON.stringify(exported, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return { status: "lifecycle-receipts-exported", out: output, receipts: exported.receipts.length, observations: exported.observations.length };
  }
  if (cli.command === "policy-update" || cli.command === "policy-upgrade") {
    const store = await acquireStewardshipStore({ ...location, owner: `sort-policy-${process.pid}` });
    try {
      const state = store.state;
      const approved = Object.entries(state.snapshots ?? {}).find(([, snapshot]) => snapshot.status === "approved");
      if (approved) throw new Error(`Policy update refused: approved snapshot ${approved[0]} still active`);
      const previous = resolveStewardshipPolicy(state.policySha256, policy);
      const targets = [policy];
      const registered = (version: Parameters<typeof knownStewardshipPolicy>[0]) => knownStewardshipPolicy(version, previous);
      const isVersion = (candidate: typeof policy, version: Parameters<typeof knownStewardshipPolicy>[0]) =>
        stewardshipPolicySha256(candidate) === stewardshipPolicySha256(registered(version));
      if (cli.command === "policy-upgrade" && !isVersion(previous, "v6") && isVersion(policy, "v6")) targets.unshift(registered("v5"));
      if (cli.command === "policy-upgrade" && isVersion(previous, "v2") && policy.authority.some((kind) => kind === "set_effort")) targets.unshift(registered("v3"));
      let current = previous;
      const changes = targets.flatMap((next) => {
        if (stewardshipPolicySha256(current) === stewardshipPolicySha256(next)) return [];
        const type = cli.command === "policy-upgrade" && ((isVersion(current, "v2") && isVersion(next, "v3"))
          || (isVersion(current, "v5") && isVersion(next, "v6"))) ? "policy-upgraded" as const : "policy-changed" as const;
        (type === "policy-upgraded" ? validateStewardshipPolicyUpgrade : validateStewardshipPolicyChange)(current, next);
        const change = { type, previous: current, next }; current = next; return [change];
      });
      const unfinished = Object.entries(state.runs).filter(([, run]) => run.resultSha256 === null);
      const at = now();
      // Exclusive ownership proves these runs no longer have a live cycle owner.
      for (const [runId, run] of unfinished) {
        const report = baseReport(store, runId, at, run.mode ?? "run", policy);
        report.failure = "abandoned_run_reconciled";
        report.summary = "Interrupted roadmap cycle reconciled; confirmed effects retained, remaining work deferred.";
        report.outcomes = Object.entries(state.actions).filter(([, action]) => action.runId === runId).map(([actionId, action]) => ({ issueNumber: action.issueNumber,
          status: "partial", reasons: ["abandoned_run"], confirmedActionIds: action.outcome === "confirmed" ? [actionId] : [], finalObservationSha256: null, finalMaterialEvidenceSha256: null, nextEligibleAt: null }));
        finish(store, report, dependencies.root);
      }
      if (state.policySha256 === stewardshipPolicySha256(policy)) return { status: "policy-current", policySha256: state.policySha256 };
      for (const change of changes) store.append({ type: change.type, previousPolicySha256: store.archive(change.previous), policySha256: store.archive(change.next) }, at);
      return { status: cli.command === "policy-upgrade" ? "policy-upgraded" : "policy-updated", policySha256: store.state.policySha256 };
    } finally { store.release(); }
  }
  let previewBytes: string | undefined;
  if (cli.command === "preview") {
    // Same refusal readStewardshipState gives, so a missing journal never surfaces as a raw ENOENT.
    try { previewBytes = readFileSync(stewardshipPaths(location).journal, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new Error("Stewardship journal missing; explicit initialization or recovery required");
    }
  }
  if (previewBytes !== undefined && !previewBytes.trim()) {
    let timing;
    try { timing = phaseTiming?.snapshot(); } catch { /* Preserve the refusal. */ }
    return { status: "refused", failure: "empty_journal", coverage: { notes: ["empty_journal"] }, ...timing };
  }
  let previewState: StewardshipState | undefined;
  // State loss must be detected before creating a transport or reading a credential.
  if (cli.command !== "init" || existsSync(stewardshipPaths(location).journal)) {
    const state = readStewardshipState(location, previewBytes);
    if (cli.command === "preview" || cli.command === "rehearse") previewState = state;
    // A read can recognize the one safe crash window. Only lock ownership repairs it.
    if (cli.command !== "preview" && cli.command !== "rehearse" && readStewardshipControlPolicy(location) !== state.policySha256) {
      const repair = await acquireStewardshipStore({ ...location, owner: `sort-repair-${process.pid}` }); repair.release();
    }
    if (cli.command === "pause" || cli.command === "resume") {
      setStewardshipPaused({ ...location, paused: cli.command === "pause", at: now() }); return { status: cli.command === "pause" ? "paused" : "resumed" };
    }
    if (cli.command === "status") {
      const artifacts = new Map<string, unknown>();
      const readArtifact = (hash: string): unknown => {
        if (!artifacts.has(hash)) artifacts.set(hash, location.artifactCache.read(stewardshipPaths(location).artifacts, hash));
        return artifacts.get(hash);
      };
      const heldSnapshot = heldSnapshotReport(state, readArtifact, location, now());
      const latestRun = Object.values(state.runs).findLast((run) => run.resultSha256 && run.mode !== "preview" && run.mode !== "shadow");
      const latestReport = latestRun?.resultSha256 ? readArtifact(latestRun.resultSha256) as Report : undefined;
      return { status: state.paused ? "paused" : "active", adoptionId: state.adoptionId, deliverySemantics: "windows_submission",
        pendingPolicyChange: state.policySha256 === stewardshipPolicySha256(policy) ? null : { from: state.policySha256, to: stewardshipPolicySha256(policy) },
        ...eligibility(state, readArtifact, now()),
        ...(heldSnapshot ? { heldSnapshot } : {}),
        ...(latestReport ? observationReportFields(latestReport) : {}),
        pendingReports: pendingReports({ state, readArtifact }),
        unresolvedActions: Object.entries(state.actions).filter(([, action]) => action.outcome === null || action.outcome === "unresolved" || action.outcome === "conflict").map(([id]) => id) };
    }
  }
  const repoRoot = dependencies.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let token: string | undefined; let checked = false; let configDirectory: string | undefined;
  const getToken = () => {
    if (!checked) { (dependencies.assertCheckout ?? (() => assertCheckout(repoRoot)))(); checked = true; }
    token ??= (dependencies.token ?? (() => process.env.ROADMAP_SORT_GITHUB_TOKEN ?? ""))();
    if (!token || !/^github_pat_[A-Za-z0-9_]+$/.test(token)) throw new Error("Explicit fine-grained child credential required"); return token;
  };
  let deadlineAt = new Date(Date.parse(now()) + policy.limits.runDurationMs).toISOString();
  let store: StewardshipStore | undefined;
  const journalBacklogCompile = (input: CompileInput, approvalEligible = true, liveRunId?: string) => {
    const snapshot = compileStewardshipBacklog(input);
    if (cli.command !== "preview") store!.append({ type: "backlog-compiled", snapshotSha256: snapshot.snapshotSha256,
      compileInputsSha256: store!.archive(input), ...(approvalEligible ? {} : { approvalEligible: false }),
      ...(liveRunId === undefined ? {} : { liveRunId }) }, now());
    return snapshot;
  };
  let replacementReport: Report | undefined;
  let replacementIssueNumbers: number[] | undefined;
  const activeEvidence = new Map<number, BoundStewardshipEvidence>();
  let compileGenerations: StewardshipEvidenceGeneration[] = [];
  let currentReport: Report | undefined;
  let pinnedMainSha: string | undefined;
  const mainTrees = new Map<string, string>();
  const blobBytes = new Map<string, string>();
  const runGit: NonNullable<CollectStewardshipEvidenceOptions["runGit"]> = (cwd, args, settings) => {
    const fullTree = cwd === repoRoot && args.length === 4 && args[0] === "ls-tree" && args[1] === "-r" && args[2] === "-z"
      && settings?.localObjectsOnly === true;
    if (fullTree && mainTrees.has(args[3])) return mainTrees.get(args[3])!;
    const localBlob = cwd === repoRoot && args.length === 3 && args[0] === "cat-file" && args[1] === "blob"
      && settings?.output === "base64" && settings.localObjectsOnly === true;
    if (localBlob && blobBytes.has(args[2])) return blobBytes.get(args[2])!;
    const value = (dependencies.runGit ?? runCredentialCleanGit)(cwd, args, settings);
    if (fullTree) mainTrees.set(args[3], value);
    if (localBlob) blobBytes.set(args[2], value);
    return value;
  };
  const blobsAtMain = (sha: string) => parseStewardshipTreeBlobs(runGit(repoRoot, ["ls-tree", "-r", "-z", sha], { localObjectsOnly: true }));
  const mainSnippets = new Map<string, ReturnType<typeof stewardshipSourceSnippetIdentity>>();
  const snippetReaderAtMain = (sha: string) => {
    let regularBlobs: Map<string, string> | undefined;
    return (path: string): ReturnType<typeof stewardshipSourceSnippetIdentity> => {
      const key = `${sha}:${path}`;
      if (!mainSnippets.has(key)) {
        let identity: ReturnType<typeof stewardshipSourceSnippetIdentity> = null;
        try {
          regularBlobs ??= parseStewardshipTreeBlobs(runGit(repoRoot, ["ls-tree", "-r", "-z", sha], { localObjectsOnly: true })
            .split("\0").filter((entry) => /^(100644|100755) blob /.test(entry)).join("\0"));
          const oid = regularBlobs.get(path);
          if (oid) identity = stewardshipSourceSnippetIdentity(path, Buffer.from(runGit(repoRoot,
            ["cat-file", "blob", oid], { output: "base64", localObjectsOnly: true }), "base64"));
        } catch { /* Unreadable pinned-main sources cannot establish snippet identity. */ }
        mainSnippets.set(key, identity);
      }
      return mainSnippets.get(key)!;
    };
  };
  let mainDrift: Report["mainDrift"];
  const currencyDiagnostics = new Set<number>();
  let priorCensus: StewardshipEvidenceGeneration["census"] | undefined;
  let uncoveredIssueNumbers: ReadonlySet<number> | undefined;
  let cachedSourcesByIssue: CollectStewardshipEvidenceOptions["cachedSourcesByIssue"];
  const readObservationAdmissions = (journal: readonly { event: StewardshipEvent }[], numbers: readonly number[]) => {
    const captures = new Map<number, { runId: string | undefined; packetSha256: string }>();
    const reports = new Map<string, string>();
    let capturingRun: string | undefined;
    for (const { event } of journal) {
      if (event.type === "run-started") capturingRun = event.runId;
      if (event.type === "evidence-recorded") captures.set(event.issueNumber, { runId: capturingRun, packetSha256: event.packetSha256 });
      if (event.type === "run-finished") {
        reports.set(event.runId, event.resultSha256);
        if (capturingRun === event.runId) capturingRun = undefined;
      }
    }
    const censuses = new Map<string, StewardshipEvidenceGeneration["census"] | null>();
    const admissions = new Map<number, StewardshipObservationAdmission>();
    for (const number of numbers) {
      const capture = captures.get(number);
      if (!capture?.runId || !reports.has(capture.runId)) continue;
      if (!censuses.has(capture.runId)) {
        let census: StewardshipEvidenceGeneration["census"] | null = null;
        try {
          const report = store!.readArtifact(reports.get(capture.runId)!) as Partial<Report>;
          if (report.mode === "run" && report.censusSha256) census = store!.readArtifact(report.censusSha256) as typeof census;
        } catch { /* An unfinished or unreadable capture has no provable admission. */ }
        censuses.set(capture.runId, census);
      }
      const census = censuses.get(capture.runId);
      const updatedAt = census?.updatedAtByIssue?.[number]; const digest = census?.digestByIssue?.[number];
      if (typeof updatedAt === "string" && updatedAt && typeof digest === "string" && digest) {
        admissions.set(number, { packetSha256: capture.packetSha256, updatedAt, digest });
      }
    }
    return admissions;
  };
  const readPriorCensus = () => {
    const entries = readJournal();
    const issueNumber = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
    const stringMap = (value: unknown) => value === undefined || (value !== null && typeof value === "object" && !Array.isArray(value)
      && Object.entries(value).every(([key, entry]) => /^[1-9]\d*$/.test(key) && issueNumber(Number(key)) && typeof entry === "string"));
    for (let index = entries.length - 1; index >= 0; index--) {
      const { event } = entries[index];
      if (event.type !== "run-finished") continue;
      try {
        const report = store!.readArtifact(event.resultSha256) as Partial<Report> | null;
        if (typeof report?.censusSha256 !== "string" || !/^[a-f0-9]{64}$/.test(report.censusSha256)) continue;
        const census = store!.readArtifact(report.censusSha256) as Partial<StewardshipEvidenceGeneration["census"]> | null;
        if (!census || census.complete !== true || !Array.isArray(census.issueNumbers) || !census.issueNumbers.every(issueNumber)
          || new Set(census.issueNumbers).size !== census.issueNumbers.length || census.totalCount !== census.issueNumbers.length
          || !Number.isSafeInteger(census.nowCount) || census.nowCount! < 0 || census.nowCount! > census.totalCount
          || (census.members !== undefined && (!Array.isArray(census.members)
            || !census.members.every((member) => member !== null && typeof member === "object" && issueNumber(member.issueNumber) && typeof member.state === "string")))
          || !stringMap(census.updatedAtByIssue) || !stringMap(census.digestByIssue)) continue;
        return census as StewardshipEvidenceGeneration["census"];
      } catch {
        // An unreadable report or census cannot displace an older usable run prior.
      }
    }
    // Shadow captures are not admission-based priors. Activation hydrates without a run census.
    return undefined;
  };
  const injectedReads = cli.command === "rehearse" ? new Set(cli.injectTransient) : undefined;
  const collectorCancellation = cli.command === "rehearse" ? new AbortController() : undefined;
  const ghExecutable = () => process.platform === "win32" ? join(process.env.ProgramFiles ?? "C:\\Program Files", "GitHub CLI", "gh.exe") : "gh";
  const ghReadOptions = (): ExecFileSyncOptionsWithStringEncoding => {
    const credential = getToken(); configDirectory ??= mkdtempSync(join(tmpdir(), "roadmap-sort-gh-"));
    return { encoding: "utf8", timeout: Math.max(1, Math.min(60_000, Date.parse(deadlineAt) - Date.parse(now()))), maxBuffer: 32 * 1024 * 1024,
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { NODE_ENV: "production", PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, SYSTEMROOT: process.env.SYSTEMROOT,
        GH_CONFIG_DIR: configDirectory, GH_TOKEN: credential, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" } };
  };
  const refuseRateLimit = () => {
    collectorCancellation!.abort();
    throw Object.assign(new Error("rehearsal_rate_limited"), { status: 429, stdout: "HTTP/2.0 429 Too Many Requests\r\n\r\n{}" });
  };
  const collectionOptions = (overrides: Partial<CollectStewardshipEvidenceOptions>, inject = false): CollectStewardshipEvidenceOptions => {
    const options: CollectStewardshipEvidenceOptions = {
    repo: { owner: "example-org", name: "example-repo", fullName: REPOSITORY }, repoRoot, trustedVerificationAuthors: [policy.operator], policyEvidence: policy,
    state: store?.state, now, generatedAt: now(), deadlineAt, ...(runAssembly ? { runGit } : {}), configuredSensitiveValues: token ? [token] : [], githubRequests, githubRequestFailures, phaseTiming,
    mode: runAssembly || cli.command === "rehearse" ? "run" : cli.command === "preview" ? "preview" : "shadow", pinnedMainSha,
    ...(runAssembly || cli.command === "rehearse" ? { priorCensusUpdatedAt: priorCensus?.updatedAtByIssue,
      priorCensusDigestByIssue: priorCensus?.digestByIssue, cachedSourcesByIssue, uncoveredIssueNumbers } : {}),
    runGh: (argv) => {
      assertReadOnlyGhArgs(argv);
      return execFileSync(ghExecutable(), [...argv], ghReadOptions());
    }, ...overrides,
    };
    return cli.command === "rehearse" ? { ...options, runGh: createRehearsalReadRunner((args) => {
      if (collectorCancellation!.signal.aborted) refuseRateLimit();
      return options.runGh!(args);
    }, inject, refuseRateLimit) } : options;
  };
  function collect(overrides: Partial<CollectStewardshipEvidenceOptions> & { targetObservation: true }, inject?: boolean): StewardshipTargetGeneration;
  function collect(overrides?: Partial<CollectStewardshipEvidenceOptions>, inject?: boolean): StewardshipEvidenceGeneration;
  function collect(overrides: Partial<CollectStewardshipEvidenceOptions> = {}, inject = false): StewardshipEvidenceGeneration | StewardshipTargetGeneration {
    const errorsBefore = Object.values(githubRequests).reduce((count, requests) => count + requests.error, 0);
    const failuresBefore = githubRequestFailures.length;
    let generation: StewardshipEvidenceGeneration | StewardshipTargetGeneration;
    const collector: (options: CollectStewardshipEvidenceOptions) => StewardshipEvidenceGeneration | StewardshipTargetGeneration = dependencies.collect ?? collectStewardshipEvidence;
    try { generation = collector(collectionOptions(overrides, inject)); } catch (error) {
      // Execution fences may turn collector failures into deferred outcomes;
      // retain the closed stale-pin code even when that path catches the error.
      if (error instanceof Error && error.name === "StewardshipEvidenceCollectionError"
        && (error as { code?: unknown }).code === "stale_pin") {
        if (currentReport) currentReport.evidenceFailure = "stale_pin";
        // Snapshot execution uses refusal messages as outcome reasons. Only the
        // closed code may cross that boundary, never collector message text.
        error.message = "stale_pin";
      }
      throw error;
    } finally {
      // Collection is synchronous: these deltas count only gh failures, excluding fetch failures.
      const errorsAfter = Object.values(githubRequests).reduce((count, requests) => count + requests.error, 0);
      githubRequestFailuresDropped += Math.max(0, errorsAfter - errorsBefore - (githubRequestFailures.length - failuresBefore));
      if (currentReport && githubRequestFailures.length) currentReport.githubRequestFailures = githubRequestFailures;
      if (currentReport && githubRequestFailuresDropped) currentReport.githubRequestFailuresDropped = githubRequestFailuresDropped;
    }
    return collected(generation);
  }
  function collected<T extends StewardshipEvidenceGeneration | StewardshipTargetGeneration>(generation: T): T {
    pinnedMainSha ??= generation.originMainSha;
    if (!("census" in generation)) return generation;
    if (generation.mainDrift || mainDrift) {
      mainDrift = { pinnedSha: pinnedMainSha, remoteMainShaAtEnd: generation.mainDrift?.remoteMainShaAtEnd ?? generation.originMainSha,
        aheadBy: Math.max(mainDrift?.aheadBy ?? 0, generation.mainDrift?.aheadBy ?? 0) };
      if (currentReport) currentReport.mainDrift = mainDrift;
    }
    if (runAssembly && currentReport) for (const packet of generation.packets) {
      const issue = store!.state.issues[packet.issueNumber];
      const reference = issue?.assessment && issue.evidencePackets?.[issue.assessment.materialEvidenceSha256];
      if (!reference || currencyDiagnostics.has(packet.issueNumber) || priorCensus?.updatedAtByIssue?.[packet.issueNumber] === undefined
        || priorCensus.updatedAtByIssue[packet.issueNumber] !== generation.census.updatedAtByIssue?.[packet.issueNumber]) continue;
      const cached = store!.readArtifact(reference.packetSha256) as StewardshipIssueEvidencePacket;
      // Initial hydration compares common currency; expanded recapture also checks the cached excerpt layout.
      const cachedKey = stewardshipAssessmentCurrencyKey(packet.evidencePhase === "initial" ? { ...cached, evidencePhase: "initial" } : cached);
      if (cachedKey !== null && cachedKey !== stewardshipAssessmentCurrencyKey(packet)) {
        currencyDiagnostics.add(packet.issueNumber);
        currentReport.diagnostics = [...(currentReport.diagnostics ?? []), { seat: null, stage: "evidence", code: "currency_without_update", field: "$", issueNumber: packet.issueNumber }];
      }
    }
    compileGenerations.push(generation);
    return generation;
  }
  const observationOptions = (selection: CollectStewardshipEvidenceOptions["selection"]): Partial<CollectStewardshipEvidenceOptions> => {
    assert(selection?.mode === "targeted", "snapshot_reads_require_targeted_selection");
    const { issueNumbers } = selection;
    const previous = issueNumbers.flatMap((number) => {
      const evidence = activeEvidence.get(number); return evidence ? [[number, evidence] as const] : [];
    });
    const first = previous[0]?.[1];
    assert(previous.every(([, evidence]) => evidence.packet.evidencePhase === first!.packet.evidencePhase
      && evidence.policySha256 === first!.policySha256), "Mixed observation evidence context");
    return { selection: { mode: "targeted", issueNumbers }, evidencePhase: first?.packet.evidencePhase ?? "initial",
      ...(first ? { policyEvidence: resolveStewardshipPolicy(first.policySha256, policy),
        sourcePathCandidatesByIssue: Object.fromEntries(previous.map(([number, evidence]) => [number, evidence.packet.coverage.explicitSourcePaths])),
        sourceExcerptsByIssue: Object.fromEntries(previous.map(([number, evidence]) => [number, evidence.packet.scout?.nominations ?? evidence.packet.sourceExcerpts ?? []])),
        ...(previous.some(([, evidence]) => evidence.packet.scout) ? { scoutByIssue: Object.fromEntries(previous.flatMap(([number, evidence]) =>
          evidence.packet.scout ? [[number, evidence.packet.scout]] : [])) } : {}) } : {}) };
  };
  function runSnapshotCollector(options: Partial<CollectStewardshipEvidenceOptions> & { targetObservation: true }): StewardshipTargetGeneration;
  function runSnapshotCollector(options: Partial<CollectStewardshipEvidenceOptions>): StewardshipEvidenceGeneration | Promise<StewardshipEvidenceGeneration>;
  function runSnapshotCollector(options: Partial<CollectStewardshipEvidenceOptions>): StewardshipEvidenceGeneration | StewardshipTargetGeneration | Promise<StewardshipEvidenceGeneration> {
    const overrides = { ...observationOptions(options.selection), ...options };
    const phase = options.targetObservation ? options.targetReadback ? "readback" : "fence" : "preflight";
    const inject = cli.command === "rehearse" && injectedReads!.delete(phase);
    if (cli.command === "rehearse" && collectorCancellation!.signal.aborted) refuseRateLimit();
    // Both runners consume this factory's identical observation and collection options.
    // Only lever (b) moves synchronous preflight I/O off-thread; live runs stay in-process.
    if (cli.command === "rehearse" && cli.preflightConcurrency === 2 && phase === "preflight") {
      const { now: clock, runGh, phaseTiming: timing, githubRequests: counts, ...serializable } = collectionOptions(overrides);
      void clock; void runGh;
      return runCollectorWorker({ options: serializable, inject, signal: collectorCancellation!.signal,
        read: (argv, done) => {
          assertReadOnlyGhArgs(argv);
          const settings = ghReadOptions();
          const child = spawn(ghExecutable(), argv, { ...settings, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
          const output: Buffer[] = []; const errors: Buffer[] = []; let bytes = 0; let failure: unknown;
          const collectOutput = (chunks: Buffer[]) => (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > settings.maxBuffer!) { failure = { code: "ENOBUFS" }; child.kill(); }
            else chunks.push(chunk);
          };
          child.stdout!.on("data", collectOutput(output)); child.stderr!.on("data", collectOutput(errors));
          child.once("error", (error) => { failure = error; });
          child.once("close", (code, signal) => done(failure ?? (code === 0 ? null : { code, signal }),
            Buffer.concat(output).toString("utf8"), Buffer.concat(errors).toString("utf8")));
          return child;
        } }, timing!, counts!, githubRequestFailures)
        .then(collected).catch((error: unknown) => {
          if ((error as { status?: number }).status === 429) refuseRateLimit();
          throw error;
        });
    }
    try {
      const generation = options.targetObservation ? collect({ ...overrides, targetObservation: true }, inject) : collect(overrides, inject);
      if (cli.command === "rehearse" && collectorCancellation!.signal.aborted) refuseRateLimit();
      return generation;
    } catch (error) {
      if (cli.command === "rehearse" && collectorCancellation!.signal.aborted) refuseRateLimit();
      throw error;
    }
  }
  const constructGitHub = dependencies.createGitHub ?? (() => createStewardshipGitHub({ repository: REPOSITORY, operator: policy.operator, getToken, now, deadlineAt, phaseTiming,
    fetchImpl: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const kind = new URL(url).pathname === "/graphql" ? "graphql" : "rest";
      try { const response = await fetch(input, init); githubRequests[kind][response.ok ? "ok" : "error"]++;
        try { phaseTiming?.response(response.status, (name) => name === "retry-after" ? response.headers.has(name) ? "" : null : response.headers.get(name)); }
        catch { /* Telemetry cannot change fetch results or request counters. */ }
        return response; }
      catch (error) { githubRequests[kind].error++; throw error; }
    },
    collectMany: (options) => runSnapshotCollector(options),
    collectTarget: (options) => runSnapshotCollector(options),
    collect: async (issueNumber) => {
      const generation = collect(observationOptions({ mode: "targeted", issueNumbers: [issueNumber] }));
      const packet = generation.packets.find((entry) => entry.issueNumber === issueNumber);
      if (!packet || packet.coverage.omittedPaths.some((path) => path.endsWith(":stale_nomination"))) throw new Error("Target evidence unavailable");
      return { evidence: bound(generation, packet), census: { complete: generation.census.complete, nowCount: generation.census.nowCount } };
    } }));
  const createGitHub = () => {
    const approval = previewState?.snapshots?.[cli.snapshotSha256 ?? ""];
    if (approval?.status === "approved") {
      const inputs = store!.readArtifact(approval.compileInputsSha256) as CompileInput;
      for (const [number, observation] of Object.entries(inputs.observations ?? {})) activeEvidence.set(Number(number), observation.evidence);
    }
    return constructGitHub();
  };
  const previewJournal: { event: StewardshipEvent; at: string }[] = cli.command === "preview"
    ? previewBytes!.trim().split("\n").map((line) => JSON.parse(line)) : [];
  const readJournal = () => cli.command === "preview" ? previewJournal : readFileSync(stewardshipPaths(location).journal, "utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as { event: StewardshipEvent });
  const compileBacklog = (generation: StewardshipEvidenceGeneration, report: Report, persist: boolean) => {
    const journal = cli.command === "preview" ? previewJournal : readFileSync(stewardshipPaths(location).journal, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line) as { event: StewardshipEvent; at: string });
    const frozen = !runAssembly ? store!.state.shadowPass : undefined;
    const numbers = frozen?.issueNumbers ?? generation.census.issueNumbers;
    const closed = new Set(frozen?.closedIssueNumbers ?? generation.census.members?.filter((member) => member.state === "CLOSED").map((member) => member.issueNumber) ?? []);
    const census = () => numbers.map((issueNumber) => {
      const member = generation.census.members?.find((member) => member.issueNumber === issueNumber);
      return { issueNumber, state: closed.has(issueNumber) ? "CLOSED" : member?.state ?? "OPEN",
        ...(member?.fields && Object.hasOwn(member.fields, "Sort key") ? { fields: { "Sort key": member.fields["Sort key"] } } : {}) };
    });
    const projectionContext = { journal, readArtifact: (hash: string) => store!.readArtifact(hash),
      state: store!.state, operator: policy.operator, initializedAt: store!.state.initializedAt };
    const currentPacketHashes = new Map<number, string>();
    for (const number of numbers) {
      const attempt = projectionContext.state.issues[number]?.attempt?.assessmentAttempt;
      if (attempt) { currentPacketHashes.set(number, attempt.packetSha256); continue; }
      const assessment = projectionContext.state.issues[number]?.assessment;
      if (!assessment) continue;
      const decision = store!.readArtifact(assessment.decisionSha256) as { assessmentSha256s?: string[] };
      if (decision.assessmentSha256s?.length !== 2) continue;
      const envelope = store!.readArtifact(decision.assessmentSha256s[0]) as { assessment: { binding: { packetSha256: string } } };
      currentPacketHashes.set(number, envelope.assessment.binding.packetSha256);
    }
    if (!runAssembly && (cli.command === "shadow" || cli.command === "preview")) {
      const recorded = new Map<number, string>();
      for (const { event } of journal) if (event.type === "evidence-recorded" && numbers.includes(event.issueNumber)) recorded.set(event.issueNumber, event.packetSha256);
      const journalPackets = [...recorded.values()].map((hash) => store!.readArtifact(hash) as StewardshipIssueEvidencePacket);
      const journalRecaptures: Record<string, StewardshipIssueEvidencePacket> = {};
      for (const hash of currentPacketHashes.values()) {
        const packet = store!.readArtifact(hash) as StewardshipIssueEvidencePacket;
        if (packet.evidencePhase === "expanded") journalRecaptures[hash] = packet;
      }
      // Archived packets establish journal coverage only; they never become live observations.
      const journalProjection = buildStewardshipProjection({ ...projectionContext, census: census(), packets: journalPackets, recapturedPackets: journalRecaptures });
      const unranked = census().filter((member) => !stewardshipProjectionCovered(member.state === "CLOSED",
        journalProjection.issues[member.issueNumber].pins, journalProjection.issues[member.issueNumber].assessment,
        journalProjection.issues[member.issueNumber].coverageOutcome)).map((member) => member.issueNumber);
      if (unranked.length) {
        // Keep the projection's own covered count (it applies refusal states such as all_abstain).
        Object.assign(report.coverage, journalProjection.coverage, { census: numbers.length, remaining: unranked.length, complete: false });
        report.unranked = [...unranked];
        report.deferred = report.deferred.filter((entry) => !journalProjection.issues[entry.issueNumber]?.coverageOutcome);
        report.stopReason = "coverage_incomplete";
        return;
      }
    }
    const packets = new Map(generation.packets.filter((packet) => numbers.includes(packet.issueNumber)).map((packet) => [packet.issueNumber, packet]));
    const packetGenerations = new Map(compileGenerations.flatMap((captured) => captured.packets.map((packet) => [packet, captured] as const)));
    const capture = (options: Partial<CollectStewardshipEvidenceOptions>) => {
      try {
        const captured = collect(options);
        if (runAssembly) for (const packet of captured.packets) archiveEvidence(store!, bound(captured, packet), now());
        if (captured.originMainSha !== generation.originMainSha) { (report.coverage.notes ??= []).push("projection_main_changed"); return null; }
        if (frozen && captured.census.complete && numbers.some((number) => closed.has(number) === captured.census.issueNumbers.includes(number))) {
          const event: StewardshipEvent = { type: "shadow-census-observed", censusSha256: store!.archive(captured.census) };
          const at = now(); store!.append(event, at);
          if (cli.command !== "preview") journal.push({ event, at });
          closed.clear(); for (const number of store!.state.shadowPass!.closedIssueNumbers) closed.add(number);
        }
        if (numbers.some((number) => !captured.census.issueNumbers.includes(number) && !closed.has(number))) {
          (report.coverage.notes ??= []).push("projection_census_changed"); return null;
        }
        return captured;
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (!(error instanceof Error) || error.name !== "StewardshipEvidenceCollectionError"
          || !(code === "mixed_generation" || (code === "invalid_evidence"
            && error.message === "Targeted evidence selection includes an issue outside the complete open census."))) throw error;
        (report.coverage.notes ??= []).push("projection_census_changed"); return null;
      }
    };
    const reused = new Map<number, BoundStewardshipEvidence>();
    const currentBlobs = runAssembly ? blobsAtMain(generation.originMainSha) : new Map<string, string>();
    const reuseRecord: StewardshipObservationReuseRecord = { reused: 0, recaptured: 0, deferred: 0,
      refusalReasons: {}, reusedIssueNumbers: [] };
    const missing = numbers.filter((number) => !closed.has(number) && !packets.has(number));
    if (runAssembly) {
      report.observationReuse = reuseRecord;
      const admissions = readObservationAdmissions(journal, missing);
      const snippetAtMain = snippetReaderAtMain(generation.originMainSha);
      for (const number of missing) {
        const result = reuseStewardshipObservation({ issueNumber: number, generation, journal, state: store!.state,
          readArtifact: (hash) => store!.readArtifact(hash), admission: admissions.get(number), blobsAtMain: currentBlobs, snippetAtMain });
        if (result.reusable) {
          reused.set(number, result.evidence); packets.set(number, result.evidence.packet);
          reuseRecord.reused++; reuseRecord.reusedIssueNumbers.push(number);
        } else reuseRecord.refusalReasons[result.reason] = (reuseRecord.refusalReasons[result.reason] ?? 0) + 1;
      }
      reuseRecord.deferred = missing.length - reused.size;
    }
    const refused = missing.filter((number) => !reused.has(number));
    const latestPackets = new Map<number, StewardshipIssueEvidencePacket | null>();
    const linkedPrCount = (number: number) => {
      if (!latestPackets.has(number)) {
        const event = latestEvidenceRecorded(journal, number)?.event;
        try { latestPackets.set(number, event?.type === "evidence-recorded" ? store!.readArtifact(event.packetSha256) as StewardshipIssueEvidencePacket : null); }
        catch { latestPackets.set(number, null); }
      }
      const pullRequests = latestPackets.get(number)?.issue?.pullRequests;
      return Array.isArray(pullRequests) ? pullRequests.length : OBSERVATION_RECAPTURE_DEFAULT_PR_COUNT;
    };
    for (let index = 0; index < refused.length; index += SNAPSHOT_EVIDENCE_CHUNK_SIZE) {
      const targets = refused.slice(index, index + SNAPSHOT_EVIDENCE_CHUNK_SIZE).filter((number) => !closed.has(number));
      if (!targets.length) continue;
      if (runAssembly) {
        const spent = Object.values(githubRequests).reduce((sum, requests) => sum + requests.ok + requests.error, 0);
        const estimate = OBSERVATION_RECAPTURE_BATCH_REQUESTS + targets.reduce((sum, number) =>
          sum + OBSERVATION_RECAPTURE_ISSUE_REQUESTS + OBSERVATION_RECAPTURE_LINKED_PR_REQUESTS * linkedPrCount(number), 0);
        if (spent + estimate > OBSERVATION_RECAPTURE_REQUEST_BUDGET) break;
      }
      const captured = capture({ selection: { mode: "targeted", issueNumbers: targets } });
      for (const packet of captured?.packets ?? []) if (numbers.includes(packet.issueNumber) && !closed.has(packet.issueNumber)) {
        packets.set(packet.issueNumber, packet); packetGenerations.set(packet, captured!);
        if (runAssembly) { reuseRecord.recaptured++; reuseRecord.deferred--; }
      }
    }
    const recapturedPackets: Record<string, StewardshipIssueEvidencePacket> = {};
    for (const layout of stewardshipProjectionRecaptures(journal, (hash) => store!.readArtifact(hash))) {
      if (!packets.has(layout.issueNumber) || closed.has(layout.issueNumber)) continue;
      if (currentPacketHashes.get(layout.issueNumber) !== layout.packetSha256) continue;
      const archived = reused.get(layout.issueNumber)?.packet;
      if (archived) {
        if (archived.evidencePhase === "expanded"
          && (archived.sourceExcerpts ?? []).every(({ path, blobOid }) => Boolean(blobOid) && currentBlobs.get(path) === blobOid)) {
          recapturedPackets[layout.packetSha256] = archived;
        }
        continue;
      }
      const held = [...packetGenerations.keys()].filter((packet) => packet.issueNumber === layout.issueNumber && packet.evidencePhase === "expanded"
        && canonicalJsonSha256((packet.sourceExcerpts ?? []).map(({ path, startLine, endLine }) => ({ path, startLine, endLine }))) === canonicalJsonSha256(layout.excerpts)).at(-1);
      if (held) {
        if (packetGenerations.get(held)!.originMainSha !== generation.originMainSha) (report.coverage.notes ??= []).push("projection_main_changed");
        else recapturedPackets[layout.packetSha256] = held;
        continue;
      }
      if (runAssembly) continue;
      const captured = capture({ selection: { mode: "targeted", issueNumbers: [layout.issueNumber] }, evidencePhase: "expanded",
        sourceExcerptsByIssue: { [layout.issueNumber]: layout.excerpts } });
      const packet = captured?.packets.find((packet) => packet.issueNumber === layout.issueNumber);
      if (packet) { recapturedPackets[layout.packetSha256] = packet; packetGenerations.set(packet, captured!); }
    }
    const projection = buildStewardshipProjection({ ...projectionContext, census: census(), packets: [...packets.values()], recapturedPackets });
    Object.assign(report.coverage, projection.coverage, { census: numbers.length, remaining: projection.coverage.unranked.length });
    report.unranked = [...projection.coverage.unranked];
    report.deferred = report.deferred.filter((entry) => !projection.issues[entry.issueNumber]?.coverageOutcome);
    const observations: Record<number, StewardshipObservation> = {};
    for (const number of numbers) {
      if (closed.has(number)) continue;
      const assessment = projection.issues[number].assessment;
      const outcome = projection.issues[number].coverageOutcome;
      const packet = (assessment && recapturedPackets[assessment.packetSha256]) || (outcome && recapturedPackets[outcome.packetSha256]) || packets.get(number);
      if (packet) {
        const captured = packetGenerations.get(packet)!;
        // The legacy compiler input type also describes live observations. Compile
        // captures only collector facts; the executor captures comments at SEND.
        const observedCensus = reused.has(number) ? generation.census : captured.census;
        observations[number] = { evidence: reused.get(number) ?? bound(captured, packet),
          census: { complete: observedCensus.complete, nowCount: observedCensus.nowCount } } as StewardshipObservation;
        if (runAssembly) activeEvidence.set(number, observations[number].evidence);
      }
    }
    const unavailable = numbers.filter((number) => !closed.has(number) && !observations[number]);
    if (unavailable.length) {
      report.stopReason = "coverage_incomplete";
      if (runAssembly) report.deferred.push(...unavailable
        .map((issueNumber) => ({ issueNumber, reason: "projection_observation_missing" })));
      return;
    }
    const completed = Object.entries(store!.state.snapshots ?? {}).filter(([, entry]) => entry.status === "completed").at(-1);
    const previousSnapshot = completed ? compileStewardshipBacklog(store!.readArtifact(completed[1].compileInputsSha256) as CompileInput) : null;
    const previous = previousSnapshot ? { issues: previousSnapshot.issues.map(({ issueNumber, horizon, reason, tier, severity, currencyKey, lifecycleReopenCurrencyKey }) =>
      ({ issueNumber, horizon, reason, tier, severity, currencyKey, lifecycleReopenCurrencyKey })) } : null;
    const input: CompileInput = { projection, observations, policy, previous, hasLiveSnapshot: Boolean(completed), firstApprovedCycleCompleted: Boolean(completed),
      ...(runAssembly ? { coveredOnly: true, observationReuse: reuseRecord } : {}),
      ...(cli.command === "preview" && !runAssembly ? dependencies.backlogContext : {}),
      ...(filingFieldReceipts === undefined ? {} : { filingFieldReceipts, filingFieldReceiptsSha256, filingFieldReceiptsText }) };
    // Capture drift grants neither approval authority nor Lifecycle observations.
    const approvalEligible = !report.coverage.notes?.some((note) => note === "projection_census_changed" || note === "projection_main_changed")
      && generation.census.complete === true
      && numbers.every((number) => closed.has(number) || observations[number]?.census.complete === true)
      // The journal pre-check can pass while capture makes an assessment stale; a shadow
      // snapshot is approvable only if the FINAL projection still covers every member.
      && (!persist || projection.coverage.complete === true);
    report.backlog = journalBacklogCompile(input, approvalEligible, runAssembly ? report.runId : undefined);
    if (persist) {
      store!.archive(report.backlog);
      report.stopReason = approvalEligible && report.backlog.status === "ready" ? "approval_required" : "coverage_incomplete";
    }
    return { input, approvalEligible };
  };
  const previewStoreOptions = { state: previewState!, policy,
    readArtifact: (hash: string) => location.artifactCache.read(stewardshipPaths(location).artifacts, hash), onEvent: () => {} };
  const liveRunProbe = () => assertRehearsalIdle(location.hostLockPort ?? hostRepositoryLockPort(REPOSITORY));
  const budgetProbe = async () => {
    (dependencies.assertCheckout ?? (() => assertCheckout(repoRoot)))(); checked = true;
    const budget = dependencies.rehearsalBudget ? await dependencies.rehearsalBudget() : await (async () => {
      const response = await fetch("https://api.github.com/rate_limit", { redirect: "error", signal: AbortSignal.timeout(30000),
        headers: { Authorization: `Bearer ${getToken()}`, Accept: "application/vnd.github+json" } });
      if (response.ok) githubRequests.rest.ok++; else githubRequests.rest.error++;
      if (!response.ok) throw new Error("rehearsal_budget_unavailable");
      const value = await response.json() as { resources: Record<string, { remaining: number; limit: number; reset: number; used: number }> };
      return Object.fromEntries(["core", "graphql"].map((name) => {
        const resource = value.resources[name];
        if (!resource || !Number.isSafeInteger(resource.remaining)) throw new Error("rehearsal_budget_unavailable");
        return [name, { minRemaining: resource.remaining, lastRemaining: resource.remaining, lastReset: resource.reset,
          limit: resource.limit, lastUsed: resource.used, responses403: 0, responses429: 0, retryAfterResponses: 0 }];
      }));
    })();
    return { budget, githubRequests, githubRequestFailures, get githubRequestFailuresDropped() { return githubRequestFailuresDropped; } };
  };
  try {
    if (cli.command === "rehearse") {
      const previewStore = store = createStewardshipPreviewStore(previewStoreOptions);
      const reads = createStewardshipRehearsalTransport(createGitHub(), () => phaseTiming!.snapshot().rateLimits);
      const writeReport = (name: string, bytes: string) => {
        if (!/^rehearsal-[a-f0-9-]+\.json$/.test(name)) throw new Error("Invalid rehearsal report name");
        const directory = join(stewardshipPaths(location).directory, "rehearsals");
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const reportPath = join(directory, name);
        writeFileSync(reportPath, bytes, { flag: "wx", mode: 0o600 });
        return reportPath;
      };
      return await runStewardshipRehearsal({ reads, store: previewStore, writeReport, policy, snapshotSha256: cli.snapshotSha256!, now,
        sleep: dependencies.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))), timing: phaseTiming!, budgetProbe, liveRunProbe,
        options: { preflightConcurrency: cli.preflightConcurrency, injectTransient: cli.injectTransient } });
    }
    store = cli.command === "preview" ? createStewardshipPreviewStore({ state: previewState!, policy,
      readArtifact: (hash: string) => location.artifactCache.read(stewardshipPaths(location).artifacts, hash), onEvent: (event, at) => { previewJournal.push({ event, at }); } }) : await acquireStewardshipStore({ ...location, owner: `sort-${process.pid}`, ...(cli.command === "init" ? { initialize: async () => {
      const generation = collect({ adoption: true });
      if (generation.baselines.some((entry) => !entry.frontiers.Priority.complete || !entry.frontiers.Horizon.complete)) throw new Error("Complete adoption histories required");
      return { adoptionId: randomUUID(), at: now(), census: { complete: true as const, issues: [...generation.baselines] } };
    } } : {}) });
    if (cli.command === "init") return { status: "initialized", adoptionId: store.state.adoptionId, census: Object.keys(store.state.issues).length };
    if (cli.command === "shadow") for (const [runId, run] of Object.entries(store.state.runs)) {
      if (run.mode !== "shadow" || run.resultSha256) continue;
      const abandoned = baseReport(store, runId, now(), "shadow", policy); abandoned.failure = "abandoned_run_reconciled";
      abandoned.summary = "Interrupted shadow slice reconciled; archived assessments retained.";
      finish(store, abandoned, dependencies.root);
    }
    if (cli.command === "approve") {
      const approveChunkSize = dependencies.approveChunkSize ?? SNAPSHOT_EVIDENCE_CHUNK_SIZE;
      if (!Number.isSafeInteger(approveChunkSize) || approveChunkSize < 1 || approveChunkSize > SNAPSHOT_EVIDENCE_CHUNK_SIZE) {
        throw new Error(`approveChunkSize must be a positive safe integer at most ${SNAPSHOT_EVIDENCE_CHUNK_SIZE}`);
      }
      const pending = store.state.pendingSnapshot;
      if (!pending || pending.snapshotSha256 !== cli.snapshotSha256) throw new Error("Unknown or superseded snapshot");
      const ageMs = pendingSnapshotAgeMs(location, pending, now());
      if (ageMs === null || ageMs > SNAPSHOT_APPROVAL_MAX_AGE_MS) throw new Error("snapshot_expired");
      const input = store.readArtifact(pending.compileInputsSha256) as CompileInput;
      const snapshot = compileStewardshipBacklog(input);
      const executable = snapshot.issues.filter((issue) => issue.targets.some((target) => target.disposition === "executable"))
        .map((issue) => issue.issueNumber).sort((a, b) => a - b);
      const stale: number[] = [];
      const unavailable = new Map<number, string>();
      const deadlineTargets = new Set<number>();
      let deadlineReached = false;
      const phases = new Map<StewardshipIssueEvidencePacket["evidencePhase"], number[]>();
      for (const number of executable) {
        const before = input.observations?.[number]?.evidence.packet;
        if (!before) { stale.push(number); continue; }
        const numbers = phases.get(before.evidencePhase) ?? [];
        numbers.push(number); phases.set(before.evidencePhase, numbers);
      }
      for (const [evidencePhase, numbers] of phases) for (let offset = 0; offset < numbers.length; offset += approveChunkSize) {
        let targets = numbers.slice(offset, offset + approveChunkSize);
        let chunkRetryUsed = false;
        for (let attempt = 0; attempt < 3 && targets.length; attempt++) {
          if (Date.parse(now()) >= Date.parse(deadlineAt)) {
            deadlineReached = true;
            for (const number of targets) deadlineTargets.add(number);
            break;
          }
          const packets = targets.map((number) => input.observations![number].evidence.packet);
          // At most (3 + 1 + 1) generations * 3 read attempts = 15, not 27.
          // Exhausted chunks get no retry without a floor, and at most one with one.
          let results: StewardshipEvidenceGeneration["targetResults"];
          let chunkFailed = false;
          let chunkCause = "";
          try { results = collect({ selection: { mode: "targeted", issueNumbers: targets }, evidencePhase,
            targetResults: true, stabilityScope: "selected",
            ...(attempt ? { maxGenerationRetries: 0 } : {}),
            sourcePathCandidatesByIssue: Object.fromEntries(packets.map((packet) => [packet.issueNumber, packet.coverage.explicitSourcePaths])),
            sourceExcerptsByIssue: Object.fromEntries(packets.map((packet) => [packet.issueNumber, packet.scout?.nominations ?? packet.sourceExcerpts ?? []])),
            scoutByIssue: Object.fromEntries(packets.flatMap((packet) => packet.scout ? [[packet.issueNumber, packet.scout]] : [])) }).targetResults; }
          catch (error) {
            const failure = error as { code?: string; message?: string; snapshotWide?: true; nextEligibleAt?: string | null } | null;
            if (failure?.code === "stale_pin" || failure?.code === "invalid_evidence"
              || failure?.snapshotWide === true) throw error;
            chunkFailed = true;
            const sensitiveValues = token ? [token] : [];
            const code = redactRoadmapSortMessage(typeof failure?.code === "string" ? failure.code : roadmapSortErrorClass(error), sensitiveValues)
              .replace(/[^\x20-\x7e]/g, "?").slice(0, 64);
            const message = redactRoadmapSortMessage(typeof failure?.message === "string" ? failure.message : "Collection failed", sensitiveValues)
              .replace(/[^\x20-\x7e]/g, "?").slice(0, 120);
            chunkCause = `${code}: ${message}`;
            results = targets.map((issueNumber) => ({ issueNumber, status: "unavailable", nextEligibleAt: failure?.nextEligibleAt }));
          }
          if (Date.parse(now()) >= Date.parse(deadlineAt)) {
            deadlineReached = true;
            for (const number of targets) {
              const matches = results?.filter((result) => result.issueNumber === number) ?? [];
              if (matches.length !== 1 || matches[0].status !== "ok") deadlineTargets.add(number);
            }
            break;
          }
          const retry: number[] = [];
          let retryAt = Date.parse(now());
          for (const number of targets) {
            const matches = results?.filter((entry) => entry.issueNumber === number) ?? [];
            const result = matches.length === 1 ? matches[0] : undefined;
            if (!result || result.status === "unavailable" || result.status === "unstable") {
              // Do not bypass a server's retry floor or the run deadline.
              const floor = result?.nextEligibleAt;
              const eligible = floor ? Date.parse(floor) : Date.parse(now());
              if (!Number.isFinite(eligible)) unavailable.set(number, ["invalid retry floor", chunkCause].filter(Boolean).join("; "));
              else if (eligible >= Date.parse(deadlineAt)) unavailable.set(number, ["retry floor beyond deadline", chunkCause].filter(Boolean).join("; "));
              else if (attempt === 2 || (chunkFailed && chunkRetryUsed)
                || (!floor && result?.status !== "unstable")) unavailable.set(number, chunkCause || result?.status || "missing or duplicate target result");
              else { retry.push(number); retryAt = Math.max(retryAt, eligible); }
              continue;
            }
            const before = input.observations![number].evidence.packet;
            const current = result.status === "ok" ? result.packet : undefined;
            const expectedKey = input.projection.issues[number].assessment?.currencyKey ?? stewardshipAssessmentCurrencyKey(before);
            const currentKey = current?.issueNumber === number && stewardshipAssessmentCurrencyKey(current);
            if (!expectedKey || !currentKey || expectedKey !== currentKey) stale.push(number);
          }
          targets = retry;
          if (chunkFailed && targets.length) chunkRetryUsed = true;
          if (attempt < 2 && targets.length && Date.parse(now()) < Date.parse(deadlineAt)) {
            try { phaseTiming?.retry(); } catch { /* Telemetry cannot alter retries. */ }
            const delay = Math.max(0, retryAt - Date.parse(now()));
            if (delay) {
              let stop: (() => void) | undefined;
              try { stop = phaseTiming?.start("collect.retryWait", false); } catch { /* Preserve the wait. */ }
              try { await (dependencies.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms))))(delay); }
              finally { try { stop?.(); } catch { /* Telemetry cannot alter approval. */ } }
            }
          }
        }
      }
      const failures: string[] = [];
      if (deadlineReached || Date.parse(now()) >= Date.parse(deadlineAt)) failures.push("snapshot_observation_deadline"
        + (deadlineTargets.size ? `: ${[...deadlineTargets].sort((a, b) => a - b).map((number) => `#${number}`).join(", ")}` : ""));
      if (unavailable.size) failures.push(`snapshot_observation_unavailable: ${[...unavailable].sort(([a], [b]) => a - b).map(([number, cause]) => `#${number}${cause ? ` (${cause})` : ""}`).join(", ")}`);
      if (stale.length) failures.push(`snapshot_superseded_stale_assessment: ${stale.sort((a, b) => a - b).map((number) => `#${number}`).join(", ")}`);
      if (failures.length) throw new Error(failures.join("; "));
      store.append({ type: "snapshot-approved", snapshotSha256: pending.snapshotSha256,
        compileInputsSha256: pending.compileInputsSha256, approvedBy: policy.operator }, now());
      const changes = Object.fromEntries([...FIELDS, "Sort key"].map((field) => [field, snapshot.issues.reduce((count, issue) => count + issue.targets.filter((target) => target.field === field && target.disposition === "executable").length, 0)]));
      const keyTargets = snapshot.issues.flatMap((issue) => issue.targets.filter((target) => target.field === "Sort key" && target.disposition === "executable"));
      const newKeys = keyTargets.flatMap((target) => typeof target.value === "number" ? [target.value] : []);
      const keySummary = `Sort key: ${keyTargets.length} changes; new values ${newKeys.length ? `${Math.min(...newKeys)}–${Math.max(...newKeys)}` : "none"}; ${keyTargets.length - newKeys.length} clears`;
      let timing;
      try { timing = phaseTiming?.snapshot(); } catch { /* Telemetry cannot change approval. */ }
      const rankInput = snapshot.inputs as CompileInput;
      const rankedNow = snapshot.report.now.map((entry) => {
        const issue = rankInput.projection.issues[entry.issueNumber]; const ranking = issue.assessment?.ranking;
        const key = stewardshipRankKey({ horizon: "Now", nowReason: entry.reason,
          covered: issue.status === "closed" || Boolean(issue.pins.Horizon || issue.pins.Effort) || issue.assessment !== null,
          tier: ranking?.tier.status === "merged" ? ranking.tier.value : null,
          value: ranking?.value.status === "merged" ? ranking.value.value : null,
          effort: ranking?.effort.status === "merged" ? ranking.effort.value : null });
        return { entry, key: key! };
      }).sort((a, b) => b.key - a.key);
      const summary = `Approved ${pending.snapshotSha256}\nNow: ${rankedNow.map(({ entry }) => `#${entry.issueNumber} (${entry.reason}, ${entry.score ?? "unscored"})`).join(", ") || "none"}\nChanges: ${JSON.stringify(changes)}\n${keySummary}\nAlarms: ${snapshot.report.alarms.join(", ") || "none"}`
        + `\nTelemetry: ${JSON.stringify({ ...timing, githubRequests })}`;
      return { status: "approved", snapshotSha256: pending.snapshotSha256, approvedBy: policy.operator, now: snapshot.report.now, changes, alarms: snapshot.report.alarms, summary, ...timing, githubRequests };
    }
    if (cli.command === "delivery") {
      store.append({ type: "report-delivery", reportSha256: cli.report!, outcome: cli.outcome! }, now()); return { status: cli.outcome, reportId: cli.report };
    }
    if (cli.command === "pin" || cli.command === "release") {
      if (cli.command === "pin") store.append({ type: "field-pinned", issueNumber: cli.issue!, field: cli.field! }, now());
      else {
        const generation = collect({ selection: { mode: "targeted", issueNumbers: [cli.issue!] } }); const packet = generation.packets[0]; if (!packet) throw new Error("Current field proof unavailable");
        const evidence = bound(generation, packet); archiveEvidence(store, evidence, now()); observeFields(store, evidence, policy, now());
        const current = store.state.issues[cli.issue!].fields[cli.field!];
        if (!current) throw new Error("Current field proof unavailable");
        store.append({ type: "field-released", issueNumber: cli.issue!, field: cli.field!, value: current.value, frontier: current.frontier }, now());
      }
      return { status: cli.command === "pin" ? "pinned" : "released", issueNumber: cli.issue, field: cli.field };
    }
    if (cli.command === "run" && isSnapshotStewardshipPolicy(policy)) {
      const state = store.state;
      const completedSha = Object.entries(state.snapshots ?? {}).filter(([, snapshot]) => snapshot.status === "completed").at(-1)?.[0];
      const pending = state.pendingSnapshot;
      if (completedSha && !Object.values(state.snapshots ?? {}).some((snapshot) => snapshot.status === "approved")
        && ((pending && pending.liveRunId === undefined) || state.shadowPass?.afterSnapshotSha256 === completedSha)) {
        const runId = randomUUID(); store.append({ type: "run-started", runId, mode: "run" }, now());
        const report = baseReport(store, runId, now(), "run", policy, githubRequests, githubRequestFailures, githubRequestFailuresDropped); report.stopReason = "shadow_pending_approval";
        if (pending) report.backlog = compileStewardshipBacklog(store.readArtifact(pending.compileInputsSha256) as CompileInput);
        report.summary = `Roadmap shadow_pending_approval: ${pending ? `snapshot ${pending.snapshotSha256}` : `shadow pass ${state.shadowPass!.passId}`}. No changes written; complete shadow and approve its snapshot before a live compile.`;
        return finish(store, report, dependencies.root, false, phaseTiming);
      }
      // Recover v2 authorities with their recorded epoch/expanded packet before the v3 path.
      for (const [, action] of stewardshipRecoveryCandidates(store.state)) {
        if (isLegacyCompilerAction(action)) continue;
        const binding = store.readArtifact(action.bindingSha256) as { authoritySha256: string };
        const authority = store.readArtifact(binding.authoritySha256) as { compile: { evidence: BoundStewardshipEvidence } };
        activeEvidence.set(action.issueNumber, authority.compile.evidence);
      }
      const recovery = await recoverStewardshipActions({ store, policy, createGitHub, now });
      const recoveryRetry = recovery.flatMap((entry) => entry.nextEligibleAt ? [entry.nextEligibleAt] : []).sort().at(-1);
      if (recoveryRetry) return { status: "not-due", nextEligibleAt: recoveryRetry };
      if (store.state.paused) return { status: "paused", pendingReports: pendingReports(store) };
      const approved = Object.entries(store.state.snapshots ?? {}).find(([, snapshot]) => snapshot.status === "approved");
      const completed = Object.values(store.state.snapshots ?? {}).some((snapshot) => snapshot.status === "completed");
      if (!approved && !completed) {
        const runId = randomUUID(); store.append({ type: "run-started", runId, mode: "run" }, now());
        const report = baseReport(store, runId, now(), "run", policy, githubRequests, githubRequestFailures, githubRequestFailuresDropped); report.stopReason = "approval_required";
        const pending = store.state.pendingSnapshot;
        if (pending) report.backlog = compileStewardshipBacklog(store.readArtifact(pending.compileInputsSha256) as CompileInput);
        report.summary = "Roadmap approval required; no changes written. Run shadow, then approve <snapshot-sha>.";
        const result = finish(store, report, dependencies.root, false, phaseTiming);
        // Preserve the legacy recovery acknowledgement; its full v2 report is durable
        // and delivered through the same pending-report path as every other run.
        return recovery.length ? { status: "awaiting-approved-snapshot" } : result;
      }
      if (approved) {
      const due = eligibility(store.state, (hash) => store!.readArtifact(hash), now());
      if (Date.parse(now()) < due.cooldown) return { status: "not-due", nextEligibleAt: due.nextEligibleAt };
      const [snapshotSha256, approval] = approved;
      const inputs = store.readArtifact(approval.compileInputsSha256) as Parameters<typeof compileStewardshipBacklog>[0];
      const approvedBacklog = compileStewardshipBacklog(inputs);
      for (const [number, observation] of Object.entries(inputs.observations ?? {})) activeEvidence.set(Number(number), observation.evidence);
      for (const [runId, run] of Object.entries(store.state.runs)) if (!run.resultSha256) {
        const abandoned = baseReport(store, runId, now(), run.mode ?? "run", policy); abandoned.failure = "abandoned_run_reconciled";
        finish(store, abandoned, dependencies.root);
      }
      const runId = randomUUID(); store.append({ type: "run-started", runId, mode: "run" }, now());
      deadlineAt = new Date(Date.parse(now()) + policy.limits.runDurationMs).toISOString();
      const report = baseReport(store, runId, now(), "run", policy, githubRequests, githubRequestFailures, githubRequestFailuresDropped);
      currentReport = report;
      if (mainDrift) report.mainDrift = mainDrift;
      report.backlog = approvedBacklog; Object.assign(report.coverage, report.backlog.report.coverage,
        { census: report.backlog.report.coverage.total, remaining: report.backlog.report.coverage.unranked.length });
      backupSnapshotJournal(stewardshipPaths(location).journal, now());
      const snapshotResults = await executeStewardshipSnapshot({ policy, store, runId, snapshotSha256, createGitHub, now, phaseTiming,
        sleep: dependencies.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))) });
      report.outcomes = snapshotResults;
      report.snapshotPlan = snapshotResults.summary;
      report.finishedAt = now();
      report.interventions = store.state.interventions?.filter((event) => Date.parse(event.at) >= Date.parse(report.startedAt)
        && Date.parse(event.at) <= Date.parse(report.finishedAt));
      report.status = store.state.snapshots?.[snapshotSha256].status === "completed" ? "updated" : "partial";
      report.summary = `${approval.liveRunId ? "Live" : "Approved"} snapshot ${snapshotSha256}: ${report.status}.`;
      if (report.status === "partial") {
        report.retryNotBefore = report.outcomes.flatMap((outcome) => outcome.nextEligibleAt ? [outcome.nextEligibleAt] : []).sort().at(-1) ?? null;
        report.continuationAt = new Date(Date.parse(now()) + policy.limits.continuationDelayMs).toISOString();
        report.nextEligibleAt = new Date(Math.max(Date.parse(report.continuationAt), Date.parse(report.retryNotBefore ?? now()))).toISOString();
      }
      if (store.state.snapshots?.[snapshotSha256].status === "replacement-required" && !approval.liveRunId && store.state.shadowPass) {
        replacementReport = report;
        replacementIssueNumbers = [...new Set(store.state.snapshots![snapshotSha256].refusal!.remaining.map((entry) => entry.issueNumber))];
        cli.command = "shadow"; // Remaining work uses the same no-write assessment/compile path.
        runAssembly = false;
      } else return finish(store, report, dependencies.root, false, phaseTiming);
      }
    }
    if (cli.command !== "preview" && cli.command !== "shadow") {
    const recoveryEligibility = eligibility(store.state, (hash) => store!.readArtifact(hash), now());
    if (recoveryEligibility.retryNotBefore && Date.parse(now()) < Date.parse(recoveryEligibility.retryNotBefore)) {
      return { status: "not-due", nextEligibleAt: recoveryEligibility.retryNotBefore, pendingReports: pendingReports(store) };
    }
    // Restore expanded capture identity for pending actions before any recovery observation.
    for (const [, action] of stewardshipRecoveryCandidates(store.state)) {
      if (isLegacyCompilerAction(action)) continue;
      const binding = store.readArtifact(action.bindingSha256) as { authoritySha256: string };
      const authority = store.readArtifact(binding.authoritySha256) as { compile: { evidence: BoundStewardshipEvidence } };
      activeEvidence.set(action.issueNumber, authority.compile.evidence);
    }
    const recovery = await recoverStewardshipActions({ store, policy, createGitHub, now });
    const recoveryRetry = recovery.flatMap((result) => result.nextEligibleAt ? [result.nextEligibleAt] : []).sort().at(-1);
    if (recoveryRetry && Object.values(store.state.runs).every((run) => run.mode === "preview" || run.resultSha256)) {
      store.append({ type: "run-started", runId: randomUUID(), mode: "run" }, now());
    }
    for (const [runId, run] of Object.entries(store.state.runs)) {
      if (run.resultSha256) continue;
      const report = baseReport(store, runId, now(), run.mode ?? "run", policy); report.failure = "abandoned_run_reconciled"; report.summary = "Interrupted roadmap cycle reconciled; confirmed effects retained, remaining work deferred.";
      if (recoveryRetry) {
        report.failure = "recovery_rate_limited"; report.retryNotBefore = recoveryRetry; report.nextEligibleAt = recoveryRetry;
        report.summary = `Roadmap recovery deferred until ${recoveryRetry}; uncertain effects remain quarantined.`;
      }
      report.outcomes = Object.entries(store.state.actions).filter(([, action]) => action.runId === runId).map(([actionId, action]) => ({ issueNumber: action.issueNumber,
        status: "partial", reasons: ["abandoned_run"], confirmedActionIds: action.outcome === "confirmed" ? [actionId] : [], finalObservationSha256: null, finalMaterialEvidenceSha256: null, nextEligibleAt: null }));
      finish(store, report, dependencies.root);
    }
    if (recoveryRetry) return { status: "not-due", nextEligibleAt: recoveryRetry, pendingReports: pendingReports(store) };
    }
    if (store.state.paused) return { status: "paused", pendingReports: pendingReports(store) };
    const due = eligibility(store.state, (hash) => store!.readArtifact(hash), now());
    if (cli.command !== "shadow" && (Date.parse(now()) < due.cooldown || (cli.scheduled && !due.scheduledDue))) return { status: "not-due", nextEligibleAt: due.nextEligibleAt, pendingReports: pendingReports(store) };
    if (cli.command === "shadow" && !isSnapshotStewardshipPolicy(policy)) throw new Error("Shadow requires policy-upgrade");
    if (cli.command === "shadow" && Object.values(store.state.snapshots ?? {}).some((snapshot) => snapshot.status === "approved")) throw new Error("Approved snapshot still active; resume run before compiling fresh");
    // Only admitted compile paths read receipts. Approved execution uses archived inputs.
    if ((cli.command === "preview" || cli.command === "shadow" || cli.command === "run" && isSnapshotStewardshipPolicy(policy)) && !loadFilingReceipts()) {
      const runId = replacementReport?.runId ?? randomUUID(); const mode = cli.command === "preview" ? "preview" : cli.command === "shadow" ? "shadow" : "run";
      if (!replacementReport) store.append({ type: "run-started", runId, mode }, now());
      const report = replacementReport ?? baseReport(store, runId, now(), mode, policy, githubRequests, githubRequestFailures, githubRequestFailuresDropped); report.failure = "invalid_filing_field_receipts";
      report.summary = "Roadmap refused: invalid_filing_field_receipts. No changes written.";
      return finish(store, report, dependencies.root, cli.command === "preview", phaseTiming);
    }
    const mode = cli.command === "preview" ? "preview" : cli.command === "shadow" ? "shadow" : "run";
    const runId = replacementReport?.runId ?? randomUUID();
    if (!replacementReport) store.append({ type: "run-started", runId, mode }, now());
    deadlineAt = new Date(Date.parse(store.state.runs[runId].startedAt) + policy.limits.runDurationMs).toISOString();
    const report = replacementReport ?? baseReport(store, runId, now(), mode, policy, githubRequests, githubRequestFailures, githubRequestFailuresDropped);
    report.githubRequests = githubRequests;
    if (githubRequestFailures.length) report.githubRequestFailures = githubRequestFailures;
    if (githubRequestFailuresDropped) report.githubRequestFailuresDropped = githubRequestFailuresDropped;
    currentReport = report;
    if (mainDrift) report.mainDrift = mainDrift;
    if (cli.command !== "preview") {
      // Read-only receipt: makes the shared-thread invalidation visible in production output. It is
      // diagnostic only, so no journal or artifact defect it meets may stop the run that renders it.
      try {
        const receipt = stewardshipAssessmentProtocolReceipt(readFileSync(stewardshipPaths(location).journal, "utf8").trim().split("\n")
          .map((line) => JSON.parse(line) as { event: StewardshipEvent; at: string }), (hash) => store!.readArtifact(hash));
        // Count only protocol invalidations; unreadable or malformed artifacts are a different signal.
        const notCurrent = receipt.invalidatedAssessments.filter((entry) => entry.reason === "assessment_protocol_not_current");
        if (notCurrent.length) report.astraAssessmentsNotCurrent = { issues: new Set(notCurrent.map((entry) => entry.issueNumber)).size,
          assessments: notCurrent.length };
      } catch { /* The report omits the receipt rather than failing the cycle. */ }
    }
    let seats: readonly StewardshipSeat[] = [];
    let passCompleted = false;
    let runCensus: StewardshipEvidenceGeneration["census"] | undefined;
    const archiveRunCensus = () => {
      if (runAssembly && runCensus) {
        // Match the journal's packet to this run's producer values. If identical
        // packet bytes came from conflicting admissions, retain neither value.
        const packetAdmissions = new Map<string, StewardshipObservationAdmission | null>();
        for (const captured of compileGenerations) for (const packet of captured.packets) {
          const packetSha256 = canonicalJsonSha256(packet);
          const updatedAt = captured.census.updatedAtByIssue?.[packet.issueNumber];
          const digest = captured.census.digestByIssue?.[packet.issueNumber];
          const admission = updatedAt && digest ? { packetSha256, updatedAt, digest } : null;
          if (!packetAdmissions.has(packetSha256)) packetAdmissions.set(packetSha256, admission);
          else if (canonicalJsonSha256(packetAdmissions.get(packetSha256)) !== canonicalJsonSha256(admission)) packetAdmissions.set(packetSha256, null);
        }
        const entries = readJournal();
        const start = entries.findLastIndex(({ event }) => event.type === "run-started" && event.runId === runId);
        const recorded = new Map<number, string>();
        for (const { event } of entries.slice(start + 1)) if (event.type === "evidence-recorded") recorded.set(event.issueNumber, event.packetSha256);
        const admittedValues = (field: "updatedAt" | "digest", prior?: Readonly<Record<number, string>>) =>
          Object.fromEntries(runCensus!.issueNumbers.flatMap((number) => {
            const hash = recorded.get(number);
            const value = hash ? packetAdmissions.get(hash)?.[field] : prior?.[number];
            return value === undefined ? [] : [[number, value]];
          }));
        report.censusSha256 = store!.archive({ ...runCensus,
          updatedAtByIssue: admittedValues("updatedAt", priorCensus?.updatedAtByIssue),
          digestByIssue: admittedValues("digest", priorCensus?.digestByIssue) });
      }
    };
    const countConsecutiveDeferredCompiles = () => {
      if (report.observationReuse) {
        if (report.backlog) {
          report.consecutiveDeferredCompiles = 0;
        } else {
          let count = 1;
          const entries = readJournal();
          for (const { event } of [...entries].reverse()) {
            if (event.type !== "run-finished") continue;
            try {
              const prior = store!.readArtifact(event.resultSha256) as Partial<Report>;
              if (prior.mode !== "run") continue;
              if (!prior.observationReuse || prior.backlog) break;
              count++;
            } catch { break; }
          }
          report.consecutiveDeferredCompiles = count;
        }
      }
    };
    try {
      compileGenerations = [];
      if (runAssembly) {
        priorCensus = readPriorCensus();
        const priorRun = Object.values(store.state.runs).findLast((run) => run.mode === "run" && run.resultSha256);
        if (priorRun?.resultSha256) try {
          const unranked = (store.readArtifact(priorRun.resultSha256) as Partial<Report> | null)?.coverage?.unranked;
          if (Array.isArray(unranked) && unranked.every((number) => Number.isSafeInteger(number) && number > 0)) {
            uncoveredIssueNumbers = new Set(unranked);
          }
        } catch { /* Missing coverage keeps the historical selection and retry behavior. */ }
        cachedSourcesByIssue = Object.fromEntries(Object.entries(store.state.issues).flatMap(([number, issue]) => {
          const reference = issue.assessment && issue.evidencePackets?.[issue.assessment.materialEvidenceSha256];
          if (!reference) return [];
          const packet = store!.readArtifact(reference.packetSha256) as StewardshipIssueEvidencePacket;
          return [[number, packet.sources.map(({ path, blobOid }) => ({ path, blobOid }))]];
        }));
      }
      let generation = collect(); runCensus = generation.census; report.coverage.census = generation.census.totalCount;
      if (generation.skippedUnchangedIssueNumbers?.length) report.skippedUnchangedIssueNumbers = [...generation.skippedUnchangedIssueNumbers];
      if (replacementIssueNumbers) {
        const remaining = replacementIssueNumbers.filter((number) => generation.census.issueNumbers.includes(number));
        if (remaining.length) generation = collect({ selection: { mode: "targeted", issueNumbers: remaining.slice(0, SNAPSHOT_EVIDENCE_CHUNK_SIZE) } });
      }
      if (cli.command === "shadow") {
        const afterSnapshotSha256 = Object.entries(store.state.snapshots ?? {}).filter(([, snapshot]) => snapshot.status === "completed").at(-1)?.[0] ?? null;
        const censusSha256 = store.archive(generation.census);
        if (!store.state.shadowPass || store.state.shadowPass.afterSnapshotSha256 !== afterSnapshotSha256) {
          store.append({ type: "shadow-pass-started", passId: runId, censusSha256, afterSnapshotSha256 }, now());
        } else store.append({ type: "shadow-census-observed", censusSha256 }, now());
        const pass = store.state.shadowPass!;
        if (generation.packets.some((packet) => !pass.issueNumbers.includes(packet.issueNumber))) {
          // New filings cannot occupy every assessment slot of an older frozen pass.
          const selected = generation.packets.filter((packet) => pass.issueNumbers.includes(packet.issueNumber)).map((packet) => packet.issueNumber);
          const eligible = pass.issueNumbers.filter((number) => !pass.closedIssueNumbers.includes(number) && !selected.includes(number)
            && (!store!.state.issues[number]?.attempt || Date.parse(store!.state.issues[number].attempt!.nextEligibleAt) <= Date.parse(now())))
            .sort((a, b) => Number(Boolean(store!.state.issues[a]?.assessment)) - Number(Boolean(store!.state.issues[b]?.assessment)) || a - b);
          // Never-assessed members first; the stable sort keeps collector (oldest-attempt) order within each group.
          const targets = [...selected, ...eligible].sort((a, b) => Number(Boolean(store!.state.issues[a]?.assessment)) - Number(Boolean(store!.state.issues[b]?.assessment))).slice(0, targetSlotLimit);
          if (targets.length) {
            generation = collect({ selection: { mode: "targeted", issueNumbers: targets } });
            store.append({ type: "shadow-census-observed", censusSha256: store.archive(generation.census) }, now());
          }
        }
      }
      const knownIssues = new Set(Object.keys(store.state.issues).map(Number));
      for (const baseline of generation.baselines) if (!knownIssues.has(baseline.issueNumber)) {
        store.append({ type: "issue-baselined", baseline }, now());
        knownIssues.add(baseline.issueNumber);
      }
      const retryAt = dailyWindow(now()).next;
      // The immutable packet index retains first witnesses, not capture order. Bind the
      // last scout failure to its preceding evidence event, including repeated hashes.
      const failedScoutEvidence = new Map<number, string>();
      const failedScoutDays = new Set<string>();
      const assessmentFailuresByDay = new Map<string, number>();
      {
        const latestEvidence = new Map<number, string>();
        const entries = cli.command === "preview" ? previewJournal : readFileSync(stewardshipPaths(location).journal, "utf8").trim().split("\n")
          .map((line) => JSON.parse(line) as { event: StewardshipEvent; at: string });
        for (const { event, at } of entries) {
          if (event.type === "evidence-recorded") latestEvidence.set(event.issueNumber, event.materialEvidenceSha256);
          if (event.type === "issue-attempted") {
            if (event.reason === "assessment_timeout" || event.reason === "assessment_failed") {
              const key = `${event.issueNumber}:${new Date(at).toISOString().slice(0, 10)}`;
              assessmentFailuresByDay.set(key, (assessmentFailuresByDay.get(key) ?? 0) + 1);
            }
            // A failed scout blocks further scouts for that issue on the same UTC calendar day, even after a main commit.
            if (event.reason === "scout_failed") failedScoutDays.add(`${event.issueNumber}:${new Date(at).toISOString().slice(0, 10)}`);
            const hash = latestEvidence.get(event.issueNumber);
            if (event.reason === "scout_failed" && hash) failedScoutEvidence.set(event.issueNumber, hash);
            else if (["assessed", "unchanged_settlement", "evidence_changed"].includes(event.reason)) failedScoutEvidence.delete(event.issueNumber);
          }
        }
      }
      const attempt = (issueNumber: number, reason: string, nextEligibleAt = reason === "scout_failed"
        ? new Date(Date.parse(retryAt) + Math.min(2 ** Math.min(store!.state.issues[issueNumber].consecutiveScoutFailures ?? 0, 3), 7) * 86_400_000).toISOString()
        : retryAt, assessmentAttempt?: Extract<StewardshipEvent, { type: "issue-attempted" }>["assessmentAttempt"]) => {
        const at = now();
        if (reason === "assessment_timeout" || reason === "assessment_failed") {
          const key = `${issueNumber}:${new Date(at).toISOString().slice(0, 10)}`;
          const failures = assessmentFailuresByDay.get(key) ?? 0;
          if (uncoveredIssueNumbers?.has(issueNumber) && failures < 3) {
            nextEligibleAt = report.continuationAt ??= new Date(Date.parse(at) + policy.limits.continuationDelayMs).toISOString();
          }
          assessmentFailuresByDay.set(key, failures + 1);
        }
        if (reason === "scout_failed") failedScoutDays.add(`${issueNumber}:${new Date(at).toISOString().slice(0, 10)}`);
        if (cli.command !== "preview" || runAssembly || assessmentAttempt) store!.append({ type: "issue-attempted", runId, issueNumber, reason, nextEligibleAt,
          ...(assessmentAttempt ? { assessmentAttempt } : {}) }, at);
      };
      for (const deferred of generation.deferredIssues) { report.deferred.push(deferred); attempt(deferred.issueNumber, deferred.reason); }
      const requests: StewardshipExecutionRequest[] = [];
      seats = dependencies.seats ?? createProductionStewardshipSeats({ policy, glmSlot: cli.glmSlot, sensitiveValues: token ? [token] : [] });
      const deferRemaining = (index: number, reason: string) => {
        for (const packet of generation.packets.slice(index)) {
          report.deferred.push({ issueNumber: packet.issueNumber, reason });
          if (reason === "seat_unavailable") attempt(packet.issueNumber, reason);
        }
      };
      const issueConcurrency = report.issueConcurrency ?? 1;
      let admissionStop: string | null = null;
      const usageStopped = new Set<number>();
      const stopAdmissions = (reason: string) => {
        if (admissionStop === null || reason === "stopped_usage_limit") admissionStop = reason;
      };
      const assessmentSeats = issueConcurrency === 1 ? seats : seats.map((seat): StewardshipSeat => ({ ...seat,
        invoke: async (input) => {
          try { return await seat.invoke(input); }
          catch (error) {
            if (error instanceof StewardshipUsageLimitError) stopAdmissions("stopped_usage_limit");
            else if (error instanceof StewardshipAssessmentError && error.detail.code === "seat_unavailable") stopAdmissions("seat_unavailable");
            throw error;
          }
        },
      }));
      const assessPacket = async (initialPacket: StewardshipIssueEvidencePacket, initialReservationsComplete: () => void) => {
        let initialReservations = 0;
        const issueStore = store!;
        let packet = initialPacket; let captured = generation;
        // Preserve the evidence layout of an expanded settlement on later cycles.
        const prior = issueStore.state.issues[packet.issueNumber];
        const priorHash = prior.settlement?.materialEvidenceSha256 ?? prior.assessment?.materialEvidenceSha256;
        const priorReference = priorHash && prior.evidencePackets?.[priorHash];
        const priorPacket = priorReference ? issueStore.readArtifact(priorReference.packetSha256) as StewardshipIssueEvidencePacket : null;
        if (priorPacket?.evidencePhase === "expanded" && prior.attempt?.reason !== "settlement_recapture_deferred") {
          // Replaying a stored layout is a read, not a fresh Phase B reservation.
          captured = collect({ selection: { mode: "targeted", issueNumbers: [packet.issueNumber] }, evidencePhase: "expanded",
            sourcePathCandidatesByIssue: { [packet.issueNumber]: priorPacket.coverage.explicitSourcePaths },
            sourceExcerptsByIssue: { [packet.issueNumber]: priorPacket.scout?.nominations ?? priorPacket.sourceExcerpts ?? [] },
            ...(priorPacket.scout ? { scoutByIssue: { [packet.issueNumber]: priorPacket.scout } } : {}) });
          const expanded = captured.packets[0];
          if (!expanded || expanded.coverage.omittedPaths.some((path) => path.endsWith(":stale_nomination"))) {
            report.deferred.push({ issueNumber: packet.issueNumber, reason: "settlement_recapture_deferred" }); attempt(packet.issueNumber, "settlement_recapture_deferred"); return;
          }
          const previousKey = stewardshipAssessmentCurrencyKey(priorPacket);
          if (previousKey !== null && previousKey === stewardshipAssessmentCurrencyKey(expanded)) packet = expanded;
          else { packet = initialPacket; captured = generation; }
        }
        let scoutFailures = prior.consecutiveScoutFailures ?? 0;
        if (scoutFailures > 0 && failedScoutEvidence.get(packet.issueNumber) !== packet.materialEvidenceSha256) {
          attempt(packet.issueNumber, "evidence_changed"); scoutFailures = 0;
        }
        let skipFailedScout = scoutFailures >= 3 || failedScoutDays.has(`${packet.issueNumber}:${new Date(now()).toISOString().slice(0, 10)}`);
        const evidence = bound(captured, packet); archiveEvidence(issueStore, evidence, now()); observeFields(issueStore, evidence, policy, now());
        const issue = issueStore.state.issues[packet.issueNumber];
        const quarantined = stewardshipUnresolvedActionReason(issueStore.state, packet.issueNumber);
        if (quarantined) { report.deferred.push({ issueNumber: packet.issueNumber, reason: quarantined }); attempt(packet.issueNumber, quarantined); return; }
        const context = holdContext(issueStore, packet.issueNumber, policy);
        const cached = issue.settlement ?? (issue.assessment?.result !== "eligible" ? issue.assessment : null);
        const stableHash = cached?.materialEvidenceSha256;
        const cachedReference = stableHash && issue.evidencePackets?.[stableHash];
        const cachedPacket = cachedReference ? issueStore.readArtifact(cachedReference.packetSha256) as StewardshipIssueEvidencePacket : null;
        const cachedKey = cachedPacket && stewardshipAssessmentCurrencyKey(cachedPacket);
        const provenanceCurrent = cached?.compilerVersion === STEWARDSHIP_COMPILER_VERSION
          && sameStewardshipSeatFamilies(cached.seatFamilies, STEWARDSHIP_PRODUCTION_SEAT_FAMILIES)
          && issue.assessment !== null
          && stewardshipDecisionAssessmentProtocolsCurrent(issue.assessment.decisionSha256, (hash) => issueStore.readArtifact(hash));
        const assessedAt = issue.assessment?.at;
        if (provenanceCurrent && stableHash && cachedKey != null && cachedKey === stewardshipAssessmentCurrencyKey(packet) && assessedAt && Date.parse(now()) - Date.parse(assessedAt) < 14 * 86_400_000) {
          report.outcomes.push({ issueNumber: packet.issueNumber, status: issue.assessment?.result === "escalated" ? "escalated" : "no-change", reasons: ["unchanged_settlement"], confirmedActionIds: [], finalObservationSha256: null, finalMaterialEvidenceSha256: stableHash, nextEligibleAt: null,
            seatFamilies: cached?.seatFamilies ?? null });
          attempt(packet.issueNumber, "unchanged_settlement"); return;
        }
        let scoutUsage: StewardshipIssueUsage["scout"];
        let scoutAdmissionClosed = false;
        let scoutFailed = false;
        const scoutTimeoutMs = (at: string) => Math.min(Date.parse(deadlineAt) - Date.parse(at),
          policy.limits.assessmentAdmissionMs - (Date.parse(at) - Date.parse(report.startedAt)))
          - 2 * (policy.limits.assessmentTimeoutMs + STEWARDSHIP_SEAT_STARTUP_MS);
        const result = await assessStewardshipIssue({ evidence, policy, seats: assessmentSeats, now, deadlineAt, ...context, sensitiveValues: token ? [token] : [],
          phaseBTrigger: (agreement) => stewardshipPhaseBTrigger(agreement, agreement.ranking?.codeNeeded.seats ?? [], dependencies.compileContextByIssue?.[packet.issueNumber]).required,
          archive: (value) => issueStore.archive(value), reserveCall: (attempt) => {
            if (admissionStop === "stopped_usage_limit") throw new StewardshipUsageLimitError();
            issueStore.append({ type: "assessment-started", runId, attempt }, now());
            if (attempt === 1 && ++initialReservations === 2) initialReservationsComplete();
          },
          archiveRejected: (answer, diagnostic) => issueStore.archiveRejected(runId, answer, diagnostic, now()),
          reserveExpansion: () => {
            if (admissionStop === "stopped_usage_limit") throw new StewardshipUsageLimitError();
            const atReservation = now();
            const scoutDay = `${packet.issueNumber}:${new Date(atReservation).toISOString().slice(0, 10)}`;
            skipFailedScout = scoutFailures >= 3 || failedScoutDays.has(scoutDay);
            if (scoutTimeoutMs(atReservation) < (skipFailedScout ? 0 : SCOUT_MIN_TIMEOUT_MS)) {
              scoutAdmissionClosed = true;
              throw new Error("Expansion admission closed");
            }
            issueStore.append({ type: "expansion-reserved", runId, issueNumber: packet.issueNumber }, atReservation);
          },
          expand: async () => {
            const timeoutMs = scoutTimeoutMs(now());
            let nomination: Awaited<ReturnType<typeof nominateStewardshipScoutExcerpts>>;
            if (skipFailedScout) nomination = { excerpts: [], scout: { outcome: "failed", usage: "unknown" } };
            else try { nomination = await (dependencies.scout ?? nominateStewardshipScoutExcerpts)({ repoRoot, originMainSha: evidence.originMainSha,
              issue: { title: packet.title, body: packet.body }, timeoutMs, sensitiveValues: token ? [token] : [] }); }
            catch { nomination = { excerpts: [], scout: { outcome: "failed", usage: "unknown" } }; }
            issueStore.archive({ issueNumber: packet.issueNumber, originMainSha: evidence.originMainSha, scout: nomination.scout });
            if (!skipFailedScout) scoutUsage = nomination.scout.usage;
            if (nomination.scout.outcome === "usage_limit") { stopAdmissions("stopped_usage_limit"); throw new StewardshipUsageLimitError(); }
            if (!skipFailedScout && ["timeout", "failed", "invalid_output"].includes(nomination.scout.outcome)) {
              scoutFailed = true; throw new Error("Scout failed");
            }
            const expanded = collect({ selection: { mode: "targeted", issueNumbers: [packet.issueNumber] }, evidencePhase: "expanded",
              sourcePathCandidatesByIssue: { [packet.issueNumber]: packet.coverage.explicitSourcePaths },
              sourceExcerptsByIssue: { [packet.issueNumber]: nomination.excerpts }, scoutByIssue: { [packet.issueNumber]: nomination.scout } });
            const next = expanded.packets[0]; if (!next) throw new Error("Expanded evidence unavailable"); return bound(expanded, next);
          } });
        const usage: StewardshipReportIssueUsage = { ...result.usage, ...(scoutUsage === undefined ? {} : { scout: scoutUsage }) };
        report.usage.push({ issueNumber: packet.issueNumber, usage });
        const resultReason = scoutAdmissionClosed ? "expansion_admission_closed" : result.reason;
        // Only local-path coverage consumes this receipt. Ordinary attempts retain
        // their historical event shape, ordering, and preview eligibility.
        const assessmentAttempt = result.diagnostics.some(({ seat, stage, code }) => seat === "glm" && stage === "input" && code === "local_path") ? {
          packetSha256: canonicalJsonSha256(result.evidence.packet), assessmentSha256s: result.assessments.map((entry) => entry.sha256),
          diagnostics: result.diagnostics.map(({ seat, stage, code, field, method }) => ({ seat, stage, code, field,
            ...(method === undefined ? {} : { method }) })),
        } : undefined;
        if (assessmentAttempt) archiveEvidence(issueStore, result.evidence, now());
        attempt(packet.issueNumber, scoutFailed ? "scout_failed" : resultReason ?? "assessed", undefined, assessmentAttempt);
        if (result.status === "stopped_usage_limit") {
          report.failure = "stopped_usage_limit";
          report.deferred.push({ issueNumber: packet.issueNumber, reason: "stopped_usage_limit",
            assessments: result.assessments.map((entry) => ({ seat: entry.envelope.seat.family, sha256: entry.sha256 })) });
          usageStopped.add(packet.issueNumber); stopAdmissions("stopped_usage_limit");
          return;
        }
        if (result.status === "deferred") {
          report.deferred.push({ issueNumber: packet.issueNumber, reason: resultReason ?? "assessment_deferred", diagnostics: result.diagnostics,
            assessments: result.assessments.map((entry) => ({ seat: entry.envelope.seat.family, sha256: entry.sha256 })) });
          if (result.reason === "call_budget_exhausted" || result.reason === "seat_unavailable") stopAdmissions(result.reason);
          return;
        }
        if (!assessmentAttempt) archiveEvidence(issueStore, result.evidence, now());
        activeEvidence.set(packet.issueNumber, result.evidence);
        const decision = compileStewardshipDecision({ evidence: result.evidence, policy, assessments: result.assessments, now: now(), census: captured.census, ...context });
        report.proposals.push({ issueNumber: packet.issueNumber, before: result.evidence.packet.fields, operations: decision.operations,
          rationale: result.assessments[0].envelope.assessment.rationale });
        if (decision.status !== "deferred") {
          issueStore.append({ type: "issue-assessed", runId, issueNumber: packet.issueNumber, materialEvidenceSha256: result.evidence.packet.materialEvidenceSha256,
            decisionSha256: issueStore.archive(decision), result: decision.status,
            usage: { ...usage, seats: usage.seats.map(({ seat, phase, attempt, usage }) => ({ seat, phase, attempt, usage })) },
            ...stewardshipDecisionProvenance(decision) }, now());
          if (decision.divergence) {
            issueStore.append({ type: "assessment-divergence-recorded", runId, issueNumber: packet.issueNumber,
              materialEvidenceSha256: result.evidence.packet.materialEvidenceSha256, assessmentSha256s: [result.assessments[0].sha256, result.assessments[1].sha256],
              differingKeys: [...decision.divergence.differingKeys], clauseIds: [...decision.divergence.clauseIds] }, now());
          }
          const concernReasons = decision.reasons.filter((reason) => reason.startsWith("concern_"));
          if (decision.divergence || concernReasons.length > 0) report.concerns.push({ issueNumber: packet.issueNumber, differingKeys: decision.divergence?.differingKeys ?? [],
            clauseCount: decision.divergence?.clauseIds.length ?? 0, ...(concernReasons.length > 0 ? { concernReasons } : {}) });
          report.assessedIssueNumbers.push(packet.issueNumber);
        } else report.deferred.push({ issueNumber: packet.issueNumber, reason: decision.reasons.join(",").slice(0, 256) });
        requests.push({ evidence: result.evidence, assessments: result.assessments, decision, census: captured.census, previewContext: context });
      };
      const packetOrder = new Map(generation.packets.map((packet, index) => [packet.issueNumber, index]));
      const compareIssues = (a: { issueNumber: number }, b: { issueNumber: number }) =>
        (packetOrder.get(a.issueNumber) ?? -1) - (packetOrder.get(b.issueNumber) ?? -1);
      const orderReport = () => {
        report.assessedIssueNumbers.sort((a, b) => compareIssues({ issueNumber: a }, { issueNumber: b }));
        for (const entries of [report.deferred, report.outcomes, report.usage, report.proposals, report.concerns]) entries.sort(compareIssues);
        if (report.diagnostics) report.diagnostics = [...report.diagnostics].sort((a, b) => compareIssues(
          { issueNumber: "issueNumber" in a ? a.issueNumber : -1 }, { issueNumber: "issueNumber" in b ? b.issueNumber : -1 }));
      };
      const inFlight = new Set<Promise<void>>();
      let issueFailure: { error: unknown } | undefined;
      let nextIndex = 0;
      try {
        while (nextIndex < generation.packets.length) {
          if (issueFailure || admissionStop) break;
          if (inFlight.size >= issueConcurrency) { await Promise.race(inFlight); continue; }
          const initialPacket = generation.packets[nextIndex];
          if (cli.command === "shadow" && !store.state.shadowPass!.issueNumbers.includes(initialPacket.issueNumber)) { nextIndex++; continue; }
          const state = store.state;
          if (policy.limits.assessmentCalls - state.runs[runId].assessmentCalls < 2) { stopAdmissions("call_budget_exhausted"); break; }
          if (Date.parse(now()) - Date.parse(report.startedAt) >= policy.limits.assessmentAdmissionMs || state.paused) { stopAdmissions("admission_closed"); break; }
          nextIndex++;
          let initialReservationsComplete!: () => void;
          const admitted = new Promise<void>((resolve) => { initialReservationsComplete = resolve; });
          const task = assessPacket(initialPacket, initialReservationsComplete)
            .catch((error: unknown) => { issueFailure ??= { error }; })
            .finally(() => { initialReservationsComplete(); inFlight.delete(task); });
          inFlight.add(task);
          // Startup can await before reserving. Admit the next issue only after the
          // initial pair uses the journal's shared accounting path, or this issue ends.
          await (issueConcurrency === 1 ? task : admitted);
        }
      } finally {
        // Drain admitted issues before compiling, closing seats, or releasing the store.
        await Promise.all(inFlight);
        if (issueConcurrency > 1) orderReport();
      }
      if (issueFailure) throw issueFailure.error;
      if (admissionStop) deferRemaining(nextIndex, admissionStop);
      if (usageStopped.size) report.unassessedIssueNumbers = generation.packets
        .filter((packet, index) => usageStopped.has(packet.issueNumber) || index >= nextIndex).map((packet) => packet.issueNumber);
      requests.sort((a, b) => compareIssues(a.evidence.packet, b.evidence.packet));
      if (issueConcurrency > 1) orderReport();
      if (cli.command === "preview" || cli.command === "shadow") {
        report.outcomes.push(...requests.map((request): StewardshipExecutionResult => ({ issueNumber: request.evidence.packet.issueNumber,
          status: request.decision.status === "eligible" ? "deferred" : request.decision.status, reasons: request.decision.status === "eligible" ? ["preview_only"] : request.decision.reasons,
          confirmedActionIds: [], finalObservationSha256: null, finalMaterialEvidenceSha256: null, nextEligibleAt: null })));
      } else if (isSnapshotStewardshipPolicy(policy)) {
        const holdArmed = reuseApprovalHoldArmed(store.state, (hash) => store!.readArtifact(hash));
        const held = holdArmed ? stewardshipHeldSnapshot(store.state, (hash) => store!.readArtifact(hash)) : undefined;
        const heldAgeMs = held ? pendingSnapshotAgeMs(location, held, now()) : null;
        const waiting = heldAgeMs !== null && heldAgeMs <= SNAPSHOT_APPROVAL_MAX_AGE_MS;
        const compiled = waiting ? undefined : compileBacklog(generation, report, false);
        const snapshot = report.backlog;
        if (waiting || (holdArmed && compiled?.approvalEligible && snapshot?.status === "ready")) {
          if (stewardshipHeldSnapshot(store.state, (hash) => store!.readArtifact(hash))) {
            report.stopReason = "shadow_pending_approval";
          } else {
            // An existing refused SHA cannot grant fresh approval authority.
            report.stopReason = "hold_awaiting_changed_compile";
            (report.coverage.notes ??= []).push("hold_awaiting_changed_compile");
          }
        } else if (compiled && snapshot?.status === "ready" && compiled.approvalEligible) {
          const { input } = compiled;
          store.append({ type: "live-snapshot-compiled", runId, snapshotSha256: snapshot.snapshotSha256,
            compileInputsSha256: store.archive(input) }, now());
          backupSnapshotJournal(stewardshipPaths(location).journal, now());
          const snapshotResults = await executeStewardshipSnapshot({ policy, store, runId, snapshotSha256: snapshot.snapshotSha256, phaseTiming,
            createGitHub, now, sleep: dependencies.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))) });
          report.outcomes.push(...snapshotResults);
          report.snapshotPlan = snapshotResults.summary;
          report.retryNotBefore = report.outcomes.flatMap((outcome) => outcome.nextEligibleAt ? [outcome.nextEligibleAt] : []).sort().at(-1) ?? null;
        } else report.stopReason = snapshot?.report.refusal ?? "coverage_incomplete";
      } else {
        const results = await executeStewardshipDecisions({ requests, policy, store, runId, createGitHub, now, sleep: dependencies.sleep ?? ((ms) => new Promise((accept) => setTimeout(accept, ms))) });
        report.outcomes.push(...results);
        const used = store.state.runs[runId];
        if (used.mutatedIssues.length >= policy.limits.changedIssues || used.remoteMutations >= policy.limits.remoteMutations) {
          for (const result of results) {
            if (!["deferred", "partial"].includes(result.status) || !requests.some((request) => request.evidence.packet.issueNumber === result.issueNumber && request.decision.status === "eligible")) continue;
            if (Object.values(store.state.actions).some((action) => action.issueNumber === result.issueNumber && [null, "unresolved", "conflict"].includes(action.outcome))) continue;
            report.continuationAt = new Date(Date.parse(now()) + policy.limits.continuationDelayMs).toISOString();
            attempt(result.issueNumber, "run_budget", report.continuationAt);
          }
        }
        for (const result of results) if (result.nextEligibleAt && Date.parse(result.nextEligibleAt) > Date.parse(now())) {
          const notBefore = new Date(Math.max(Date.parse(retryAt), Date.parse(result.nextEligibleAt))).toISOString();
          attempt(result.issueNumber, "remote_retry_deadline", notBefore);
          report.retryNotBefore = new Date(Math.max(Date.parse(report.retryNotBefore ?? now()), Date.parse(result.nextEligibleAt))).toISOString();
        }
        for (const result of results) if (result.status === "updated" && result.finalMaterialEvidenceSha256) {
          const decision = requests.find((request) => request.evidence.packet.issueNumber === result.issueNumber)!.decision;
          store.append({ type: "issue-settled", runId, issueNumber: result.issueNumber,
            materialEvidenceSha256: result.finalMaterialEvidenceSha256, executionSha256: store.archive(result), ...stewardshipDecisionProvenance(decision) }, now());
        }
      }
      if (issueConcurrency > 1) orderReport();
      if (cli.command === "preview" || cli.command === "shadow") {
        compileBacklog(generation, report, cli.command === "shadow");
        if (runAssembly && report.backlog?.status !== "ready") report.stopReason = report.backlog?.report.refusal ?? "coverage_incomplete";
      }
      const coverageState = store.state;
      const eligibleRemaining = (cli.command === "shadow" ? store.state.shadowPass!.issueNumbers : generation.census.issueNumbers).filter((number) => {
        if (runAssembly && report.skippedUnchangedIssueNumbers?.includes(number)) return false;
        const issue = coverageState.issues[number];
        return !issue?.attempt || issue.attempt.reason === "run_budget" || Date.parse(issue.attempt.nextEligibleAt) <= Date.parse(now());
      });
      if (cli.command !== "shadow" && !(runAssembly && isSnapshotStewardshipPolicy(policy))) report.coverage.remaining = eligibleRemaining.length;
      if (eligibleRemaining.length) report.continuationAt = new Date(Math.max(Date.parse(now()), Date.parse(report.startedAt)) + policy.limits.continuationDelayMs).toISOString();
      // Keep issues beyond this slice scheduled for continuation.
      if (runAssembly && priorCensus?.updatedAtByIssue && generation.census.updatedAtByIssue) {
        for (const number of eligibleRemaining) if (coverageState.issues[number]?.assessment
          && !generation.selectedIssueNumbers.includes(number)) attempt(number, "run_budget", report.continuationAt!);
      }
      if (report.failure === "stopped_usage_limit") {
        report.coverage.remaining = report.unassessedIssueNumbers!.length;
        report.continuationAt = null;
      }
      passCompleted = !report.failure && report.deferred.length === 0 && report.coverage.remaining === 0
        && report.outcomes.every((outcome) => outcome.status !== "partial" && outcome.status !== "deferred");
    } catch (error) {
      report.failure = "cycle_failed_closed";
      // Only the collector's closed code is recorded; an arbitrary message never reaches a report.
      const collection = error as { name?: unknown; code?: unknown; cause?: unknown; transientHttp?: unknown } | null;
      if (collection?.name === "StewardshipEvidenceCollectionError"
        && (collection.code === "mixed_generation" || collection.code === "read_exhausted" || collection.code === "invalid_evidence" || collection.code === "stale_pin")) report.evidenceFailure = collection.code;
      if (report.evidenceFailure === "read_exhausted" && (collection?.cause === "deadline" || collection?.cause === "after_deadline"
        || collection?.cause === "rate_limited" || collection?.cause === "forbidden" || collection?.cause === "transport")) report.evidenceFailureCause = collection.cause;
      const next = (error as { nextEligibleAt?: unknown } | null)?.nextEligibleAt;
      if (typeof next === "string" && Number.isFinite(Date.parse(next)) && Date.parse(next) > Date.parse(now())) report.retryNotBefore = next;
      // A trusted HTTP blip that outlasted the attempt budget continues on the next
      // slice, not the next daily window. Other transport-coded failures (refusals,
      // process and collector faults) keep the daily window; retryNotBefore still gates.
      if (report.evidenceFailureCause === "transport" && collection?.transientHttp === true) report.continuationAt ??= new Date(Date.parse(now()) + policy.limits.continuationDelayMs).toISOString();
    } finally {
      try { archiveRunCensus(); }
      catch {
        delete report.censusSha256;
        report.diagnostics = [...(report.diagnostics ?? []), { seat: null, stage: "archive", code: "refused", field: "$.censusSha256" }];
      }
      try { countConsecutiveDeferredCompiles(); }
      catch {
        report.diagnostics = [...(report.diagnostics ?? []), { seat: null, stage: "runtime", code: "refused", field: "$.consecutiveDeferredCompiles" }];
      }
      const closed = await Promise.allSettled(seats.map((seat) => Promise.resolve().then(() => seat.close?.())));
      if (!report.failure && closed.some((result) => result.status === "rejected")) {
        if (passCompleted) report.diagnostics = [...(report.diagnostics ?? []), { seat: null, stage: "transport", code: "assessment_cleanup_failed", field: "$" }];
        else report.failure = "seat_cleanup_failed";
      }
    }
    const current = baseReport(store, runId, now(), report.mode, policy); report.finishedAt = current.finishedAt; report.holds = current.holds; report.unresolvedActionIds = current.unresolvedActionIds;
    report.nextEligibleAt = new Date(Math.max(Date.parse(report.continuationAt ?? dailyWindow(now()).next), Date.parse(report.retryNotBefore ?? now()))).toISOString();
    report.status = report.failure === "stopped_usage_limit" ? "stopped_usage_limit" : report.failure || report.deferred.length || report.coverage.remaining || report.outcomes.some((entry) => entry.status === "partial" || entry.status === "deferred") ? "partial"
      : report.outcomes.some((entry) => entry.status === "updated") ? "updated" : report.outcomes.some((entry) => entry.status === "escalated") ? "escalated" : "nochange";
    report.summary = `Roadmap ${report.status}: ${report.outcomes.reduce((count, entry) => count + entry.confirmedActionIds.length, 0)} confirmed changes; ${report.assessedIssueNumbers.length} assessed; ${report.deferred.length} deferred; ${report.concerns.length} issues with concerns; ${report.coverage.remaining ?? "unknown"} eligible remaining. Next: ${report.nextEligibleAt}.`;
    if (report.stopReason === "approval_required") report.summary += `${replacementReport ? " Replacement snapshot;" : " Snapshot ready;"} approval required.`;
    if (report.mode === "preview" && report.coverage.total !== undefined) report.summary += ` Projection: ${report.coverage.covered}/${report.coverage.total} covered; ${report.coverage.needsEvidence} need evidence; ${report.coverage.unranked?.length ?? 0} unranked${report.coverage.refusal ? `; refused: ${report.coverage.refusal}` : ""}.`;
    if (report.coverage.notes?.length) report.summary += ` Coverage notes: ${[...new Set(report.coverage.notes)].join(", ")}.`;
    if (report.unassessedIssueNumbers) report.summary += ` Unassessed: ${report.unassessedIssueNumbers.map((number) => `#${number}`).join(", ")}.`;
    if (report.deferred.some((entry) => entry.reason === "seat_unavailable")) report.summary += " Astra seat unavailable (seat_unavailable); remaining selected issues deferred without model calls.";
    return finish(store, report, dependencies.root, cli.command === "preview", phaseTiming);
  } finally {
    store?.release();
    if (configDirectory) rmSync(configDirectory, { recursive: true, force: true });
  }
}

export const ROADMAP_SORT_STDOUT_BUDGET_BYTES = 1_048_576;

function roadmapSortErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return "NonError";
  const name = error.name;
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "NonError";
}

function redactRoadmapSortMessage(message: string, configuredSensitiveValues: readonly string[] = []): string {
  for (const secret of configuredSensitiveValues) if (secret) message = message.replaceAll(secret, "[REDACTED]");
  return message
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_TOKEN]")
    .replace(/(\bAuthorization:[ \t]*(?:(?:Bearer|Basic)[ \t]+)?|\b(?:Bearer|Basic)[ \t]+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(x-access-token:)[^\s@]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@?#"']+@/gi, "$1[REDACTED]@")
    .replace(/\?[^\s"'\])}>]*/g, "?[REDACTED]")
    .replace(/[A-Z]:[\\/]Users[\\/][^\\/\s"']+([\\/][^\s"']*)?/gi,
      (_path, suffix: string | undefined) => suffix && /[^\\/]/.test(suffix) ? `<profile>\\...\\${suffix.split(/[\\/]/).at(-1)}` : "<profile>")
    .replace(/[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]")
    .replace(/[A-Za-z0-9+/_=-]{40,}/g, (blob) => {
      if (/^[a-f0-9]{64}$/.test(blob)) return blob;
      // Keep non-id hex redaction while preserving lowercase identifiers.
      return /[A-Z0-9]/.test(blob) || /^[a-f0-9]+$/.test(blob) ? "[REDACTED_BLOB]" : blob;
    })
    .replace(/\s+/g, " ").trim();
}

/** Emit bounded diagnostics without exposing credentials or the user's profile. */
export function formatRoadmapSortFailure(error: unknown, configuredSensitiveValues: readonly string[] = []): string {
  try {
    const record = error !== null && (typeof error === "object" || typeof error === "function")
      ? error as Record<string, unknown> : undefined;
    let message = redactRoadmapSortMessage(String(record && "message" in record ? record.message : error), configuredSensitiveValues);
    if (message.length > 500) message = `${message.slice(0, 500)}...`;
    let context = "";
    if (record && Object.prototype.hasOwnProperty.call(record, "phase")) {
      const phase = record.phase;
      if (typeof phase === "string" && /^[a-z_]{1,40}$/.test(phase)) context += ` phase=${phase}`;
    }
    if (record && Object.prototype.hasOwnProperty.call(record, "issueNumber")) {
      const issueNumber = record.issueNumber;
      if (typeof issueNumber === "number" && Number.isSafeInteger(issueNumber) && issueNumber > 0) context += ` issue=#${issueNumber}`;
    }
    if (error instanceof Error && error.cause !== undefined) context += ` cause=${roadmapSortErrorClass(error.cause)}`;
    return `Roadmap sort refused or failed.\nerror: ${roadmapSortErrorClass(error)} ${message}${context}`.slice(0, 1_000);
  } catch {
    return "Roadmap sort refused or failed.\nerror: UnformattableError";
  }
}

export function reportRoadmapSortFailure(error: unknown,
  write: { stdout: (text: string) => unknown; stderr: (text: string) => unknown }): void {
  const line = `${formatRoadmapSortFailure(error)}\n`;
  try { write.stdout(line); } catch { /* Still attempt stderr if stdout fails. */ }
  try { write.stderr(line); } catch { /* Reporting must not prevent the failure exit code. */ }
}

function roadmapBacklogStdoutDigest(backlog: Backlog & { compileInputsSha256?: unknown }) {
  const executableTargets = Object.fromEntries([...FIELDS, "Start command"].map((field) => [field,
    backlog.issues.reduce((count, issue) => count + issue.targets.filter((target) => target.field === field && target.disposition === "executable").length, 0)]));
  const report = backlog.report;
  return {
    snapshotSha256: backlog.snapshotSha256, status: backlog.status,
    ...(backlog.compileInputsSha256 === undefined ? {} : { compileInputsSha256: backlog.compileInputsSha256 }),
    issueCount: backlog.issues.length, executableTargets,
    report: { now: report.now.length, enteredNow: report.enteredNow.length, leftNow: report.leftNow.length,
      escalated: report.escalated.length, abstained: report.abstained.length, unranked: report.unranked.length,
      disagreements: report.disagreements.length, flags: report.flags.length, pinsHonored: report.pinsHonored.length,
      alarms: report.alarms, refusal: report.refusal },
    digest: true,
  };
}

/** Keep the archived result intact; only the CLI presentation drops compile inputs. */
export function formatRoadmapSortStdout(command: string, result: unknown,
  writeStderr: (line: string) => unknown = (line) => process.stderr.write(line)): string {
  if (command === "approve" || command === "rehearse" || command === "--help") {
    const summary = (result as { summary: string }).summary;
    if (Buffer.byteLength(summary, "utf8") <= ROADMAP_SORT_STDOUT_BUDGET_BYTES) return summary;
  }
  const record = result !== null && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : {};
  const digests: Record<string, ReturnType<typeof roadmapBacklogStdoutDigest>> = {};
  // Shadow, preview, pending-approval and live run reports all attach a compile at
  // `backlog`; recognize its shape rather than binding presentation to that key.
  for (const [key, value] of Object.entries(record)) {
    if (value !== null && typeof value === "object" && "snapshotSha256" in value
      && typeof value.snapshotSha256 === "string" && "inputs" in value && "issues" in value && Array.isArray(value.issues)) {
      try {
        Object.defineProperty(digests, key, { value: roadmapBacklogStdoutDigest(value as Backlog), enumerable: true });
      } catch (error) {
        // Preserve lookalikes for the normal JSON byte budget and fallback.
        try {
          const label = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) ? ` for ${key}` : "";
          writeStderr(`roadmap stdout digest skipped${label}: ${roadmapSortErrorClass(error)}\n`);
        } catch {
          // Diagnostic formatting and writer failures must not affect stdout.
        }
      }
    }
  }
  let output = JSON.stringify(Object.keys(digests).length ? { ...record, ...digests } : result) ?? "undefined";
  const originalBytes = Buffer.byteLength(output, "utf8");
  if (originalBytes <= ROADMAP_SORT_STDOUT_BUDGET_BYTES) return output;
  const stdoutTruncated = { originalBytes };
  output = JSON.stringify({ mode: record.mode, status: record.status, stopReason: record.stopReason, summary: record.summary,
    ...(Array.isArray(record.assessedIssueNumbers) && record.assessedIssueNumbers.every((number) => typeof number === "number")
      ? { assessedIssueNumbers: record.assessedIssueNumbers } : {}),
    ...(Array.isArray(record.usage) ? { usage: record.usage } : {}),
    ...digests, stdoutTruncated });
  if (Buffer.byteLength(output, "utf8") > ROADMAP_SORT_STDOUT_BUDGET_BYTES) {
    output = JSON.stringify({ summary: record.summary, ...digests, stdoutTruncated });
    if (Buffer.byteLength(output, "utf8") > ROADMAP_SORT_STDOUT_BUDGET_BYTES) {
      // A JSON-escaped UTF-16 code unit takes at most six bytes. Bound even a
      // pathological summary while retaining the truncation receipt.
      const overhead = Buffer.byteLength(JSON.stringify({ summary: "", stdoutTruncated }), "utf8");
      const summary = typeof record.summary === "string"
        ? record.summary.slice(0, Math.floor((ROADMAP_SORT_STDOUT_BUDGET_BYTES - overhead) / 6)) : undefined;
      output = JSON.stringify({ summary, stdoutTruncated });
    }
  }
  assert(Buffer.byteLength(output, "utf8") <= ROADMAP_SORT_STDOUT_BUDGET_BYTES, "Roadmap stdout fallback exceeds its byte budget");
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runRoadmapSort(process.argv.slice(2)).then((result) => { process.stdout.write(`${formatRoadmapSortStdout(process.argv[2], result)}\n`); })
    .catch((error: unknown) => {
      reportRoadmapSortFailure(error, { stdout: (text) => process.stdout.write(text), stderr: (text) => process.stderr.write(text) });
      process.exitCode = 1;
    });
}
