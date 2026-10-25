import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import {
  assertDistinctRoadmapArtifactPaths,
  assertRoadmapArtifactOutputPath,
  writeRoadmapArtifactAtomically,
} from "./artifact-io";
import { canonicalJsonSha256, prettyCanonicalJson } from "./canonical-json";
import {
  assessmentStackSha256,
  assertEffectiveIntakeEnvelopeBudgets,
  assertIntakeEnvelopeByteBudgets,
  intakeAssessmentSha256,
  parseIntakeAssessment,
  type IntakeAssessment,
  type IntakeMatchResult,
  type AssessmentStackIdentity,
} from "./intake-assessment";
import {
  compileIntakeDecision,
  deriveIntakeObservationOperands,
  noveltyRevalidationFailed,
  parseIntakeCapabilityManifest,
  type AuthorityDisposition,
  type IntakeActionDecision,
  type IntakeCapability,
  type IntakeDecision,
} from "./intake-decision";
import {
  buildIntakeIssueDraft,
  intakeDenialReason,
  type CreateIssuePayload,
  type IntakeIssueDraft,
  type IntakeEvidenceCoverage,
} from "./intake-issue-draft";
import {
  bankIntakeAttempt,
  bankIntakeObservations,
  intakeAttemptFailure,
  type IntakeAttemptRecord,
  type IntakeAttemptStage,
} from "./intake-observation";
import {
  CLASSIFICATION_COVERAGE_DOMAINS,
  NOVELTY_RECEIPT_DOMAINS,
  parseIntakeSnapshotV1,
  type IntakeReceiptDomain,
  type IntakeSnapshotV1,
} from "./intake-snapshot";
import {
  parseOutcomeEnvelope,
  type OutcomeEnvelope,
} from "./outcome-candidate";
import { effectiveOutcomeCandidates, type DispositionHistoryLookup } from "./disposition-selection";
import { intakeDispositionSkips, type IntakeDispositionSkip } from "./intake-assessment";

/**
 * Shadow mode: compile the real intake decision and present it, with no way to take it.
 *
 * The module is deliberately dependency-poor. It imports no credential, deployment, consumption
 * ledger, host lock, or mutation transport module, directly or transitively, and it opens no
 * socket. Its caller injects the disposition lookup for the verified main SHA.
 * The absence of mutation authority — asserted mechanically over the import closure in
 * `scripts/__tests__/github-issue-roadmap-intake-shadow.test.ts` — is the structural proof behind
 * R2. The recorded event vocabulary below is the behavioural half: it has no credential-release
 * kind, so a run that completes with a mutation-capable token in the environment can be shown to
 * have released nothing rather than merely to have written nothing.
 *
 * R6: shadow mode never calls GitHub. It consumes the snapshot artifact that
 * `roadmap:intake-preflight` produced through the read-only reader, and asserts that artifact is
 * fresh at the moment of consumption (see `SHADOW_SNAPSHOT_MAXIMUM_AGE_MS`).
 *
 * This module absorbs the pipeline that used to live in the orphaned
 * `scripts/github-issue-roadmap-intake-review.ts` root (KTD3). Imports flow CLI -> lib only;
 * nothing here may reach back into `scripts/github-issue-roadmap-intake.ts`.
 */

export const INTAKE_SHADOW_SCHEMA = "github-issue-roadmap-intake-shadow/v1";

/**
 * The named file-consumption bound on snapshot staleness.
 *
 * `buildIntakeSnapshot`'s `maximumAgeMs` is a *within-capture* invariant: it bounds the gap between
 * a census pass and the snapshot's own `generatedAt` at build time. Nothing in it bounds how long
 * afterwards the written artifact may be consumed. A novelty claim compiled against an hours-old
 * census is not a novelty claim about the canonical roadmap any more, so shadow mode refuses it.
 *
 * The bound is applied to the oldest read receipt, not to `generatedAt` — see
 * `assertSnapshotFreshness` for why only the receipts are trustworthy evidence of when GitHub was
 * actually read.
 */
export const SHADOW_SNAPSHOT_MAXIMUM_AGE_MS = 3_600_000;

/**
 * The receipt domains the novelty decision rests on, each of which must be both present and fresh.
 *
 * Recency alone is not coverage. Novelty is decided against the marker index, and markers live in
 * issue comments as often as in issue bodies, so a snapshot carrying a fresh `issues` receipt over
 * an absent or stale `comments` census can report a candidate as novel while a marker-bearing
 * comment already records it. In shadow mode that manufactures a duplicate *recommendation*, which
 * then lands in the corpus that will later be read as evidence for enabling a real writer — the
 * harm is corrupted calibration evidence, not a bad write, and it is not a smaller harm.
 *
 * Matching is on the receipt's own `domain` discriminator, never on endpoint substrings: REST paths
 * for comments are not obliged to contain the word, and `domain` is the closed field the receipt
 * already carries for exactly this purpose.
 *
 * Re-exported from the producer rather than restated: `assertCompletePass` enforces the same list
 * when the snapshot is built, and a consumer that quietly disagreed with the producer about which
 * domains a novelty verdict needs would be the same forking this module avoids elsewhere by sharing
 * one constant.
 */
export const SHADOW_REQUIRED_RECEIPT_DOMAINS: readonly IntakeReceiptDomain[] = NOVELTY_RECEIPT_DOMAINS;

/**
 * The closed event vocabulary of a shadow run. No kind in it releases a credential, opens a
 * transport, or names a mutation; adding one that did would fail the R2 acceptance test.
 */
export const INTAKE_SHADOW_EVENT_KINDS = [
  "input_read",
  "snapshot_freshness_verified",
  "classification_evidence_qualified",
  "decision_compiled",
  "draft_rendered",
  "hold_presented",
  "replay_recorded",
  "artifact_written",
] as const;

export type IntakeShadowEventKind = typeof INTAKE_SHADOW_EVENT_KINDS[number];

export interface IntakeShadowEvent {
  readonly kind: IntakeShadowEventKind;
  readonly detail: string;
}

export type IntakeShadowPresentation = "draft" | "hold" | "replay_no_op";

/**
 * Why routine intake stopped short of a fileable draft. `novelty_revalidation_failed` is the case
 * where the snapshot itself can no longer support a novelty verdict (marker corruption, incomplete
 * novelty coverage, or the same fingerprint carried by more than one canonical issue).
 */
export type IntakeShadowHoldReason =
  | "ambiguous_match"
  | "novelty_revalidation_failed";

export interface IntakeShadowCompetingIssue {
  readonly number: number;
  readonly title: string;
  readonly state: "OPEN" | "CLOSED";
  readonly updatedAt: string;
}

export interface IntakeShadowHold {
  readonly reason: IntakeShadowHoldReason;
  readonly issue: CreateIssuePayload | null;
  readonly competingIssueNumbers: readonly number[];
  readonly competingIssues: readonly IntakeShadowCompetingIssue[];
  readonly evidenceIds: readonly string[];
  readonly rationale: string;
}

/** R10: an action the decision intended that routine intake is not permitted to take. */
export interface IntakeShadowDeniedAction {
  readonly action: string;
  readonly disposition: Exclude<AuthorityDisposition, "automatic_safe">;
  readonly proposed: unknown;
  readonly targetIssueNumber: number | null;
  readonly requiredCapabilities: readonly IntakeCapability[];
  readonly rationale: string;
  readonly deniedReason: string;
}

export interface IntakeShadowCandidate {
  readonly sourceFingerprint: string;
  readonly matchResult: IntakeMatchResult;
  readonly presentation: IntakeShadowPresentation;
  /** The complete ordinary draft, or `null` for a hold or a replay. */
  readonly draft: IntakeIssueDraft | null;
  readonly hold: IntakeShadowHold | null;
  readonly intendedButDenied: readonly IntakeShadowDeniedAction[];
}

export interface IntakeShadowReport {
  readonly schemaVersion: typeof INTAKE_SHADOW_SCHEMA;
  readonly generatedAt: string;
  readonly repository: IntakeDecision["repository"];
  readonly capabilityManifestId: string | null;
  readonly snapshotGeneratedAt: string;
  readonly consumedAt: string;
  /**
   * Per-domain evidence quality for the classification data this report's recommendations rest on.
   * `assumed` marks a domain the decision read without an attested, fresh census.
   */
  readonly classificationEvidence: ClassificationEvidence;
  readonly decision: IntakeDecision;
  /** Retained assessment material remains bound even when terminal entries are excluded. */
  readonly assessmentInputSha256?: string;
  /** Allows collect to recover an interrupted report-to-plan retirement checkpoint. */
  readonly previousDecisionSha256s?: readonly string[];
  readonly candidates: readonly IntakeShadowCandidate[];
  readonly skipped: readonly IntakeDispositionSkip[];
}

export interface IntakeShadowRunResult {
  readonly outputPath: string;
  readonly report: IntakeShadowReport;
  readonly events: readonly IntakeShadowEvent[];
  readonly summary: readonly string[];
}

export interface IntakeShadowRunInput {
  /** The caller supplies history lookup; production pins it to the verified main SHA. */
  readonly dispositionHistory: DispositionHistoryLookup;
  readonly candidate: string;
  readonly snapshot: string;
  readonly assessment: string;
  readonly existence?: string;
  readonly verifiedOriginMainSha?: string;
  readonly capabilities?: string | null;
  readonly out: string;
  /**
   * Required, not defaulted. The closure may not read `process.cwd()` — the shadow boundary gate
   * bans `process` flatly — so the repo root is injected at the boundary by the CLI that owns it.
   */
  readonly repoRoot: string;
  /** Injected clock, so snapshot freshness is asserted against a value a test can drive. */
  readonly now?: Date;
  readonly log?: (line: string) => void;
  /** Optional repository-owned stack pin used by the scheduled host handshake. */
  readonly expectedAssessmentStack?: AssessmentStackIdentity;
}

function readJson(path: string, context: string, onRead?: (bytes: Buffer) => void): unknown {
  try {
    const bytes = readFileSync(path);
    onRead?.(bytes);
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${context} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The span of GitHub reads a snapshot's receipts attest to, as verified at consumption. */
interface ReceiptObservationWindow {
  readonly oldestFetchedAt: string;
  readonly newestFetchedAt: string;
  readonly receiptCount: number;
  readonly oldestAgeMs: number;
  readonly classificationEvidence: ClassificationEvidence;
}

/**
 * Whether each classification domain the decision reads was actually attested by a fresh receipt.
 *
 * `attested` means the snapshot declared that census complete AND carries a receipt for it that is
 * inside the consumption bound. `assumed` means it did not, and the decision read the data anyway.
 *
 * This is recorded rather than enforced, deliberately. Refusing would mean shadow mode stays silent
 * about issues whose Type / Priority / Effort / Horizon were not re-read, which is the opposite of
 * what this branch is for — it exists to produce as many recommendations as it honestly can. What it
 * may not do is let a recommendation built on an unattested census look identical to one built on a
 * fresh read, because the corpus of these recommendations is the evidence for whether a real writer
 * is ever enabled. So the qualification travels *with* the recommendation, as a machine-readable
 * field a later calibration pass can filter on rather than a sentence in a log.
 */
export type ClassificationEvidenceState = "attested" | "assumed";

export type ClassificationEvidence = Readonly<Record<
  typeof CLASSIFICATION_COVERAGE_DOMAINS[number],
  ClassificationEvidenceState
>>;

/**
 * R1: the decision is compiled against a snapshot that is fresh *at consumption*, not merely one
 * that was internally consistent when it was captured.
 *
 * Freshness is read from the receipts, never from `snapshot.generatedAt`. `buildIntakeSnapshot`
 * hashes a `core` object into `contentSha256`; `generatedAt` sits outside it, so an otherwise valid
 * stale snapshot can have its `generatedAt` rewritten forward while the content hash and the
 * assessment binding both stay valid — a forged timestamp would have passed every other gate. The
 * receipts *are* inside `core` and each carries the `fetchedAt` of the GitHub read it attests to,
 * so bounding the oldest of them is a claim the content hash actually covers. `generatedAt` remains
 * on the wire and in the report as informational provenance only.
 *
 * Recency is only half the question. A receipt set proves *when* GitHub was read, not *what* was
 * read, so this also requires present-and-fresh coverage for every domain the novelty decision
 * depends on — see `SHADOW_REQUIRED_RECEIPT_DOMAINS`. Element shape (endpoint, domain, parseable
 * `fetchedAt`) is already settled by `parseIntakeSnapshotV1`; what is left here is everything that
 * needs a clock and a bound.
 */
export function assertIntakeSnapshotFreshForShadow(
  snapshot: IntakeSnapshotV1,
  now: Date,
): ReceiptObservationWindow {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Shadow intake clock must be a valid date.");
  if (snapshot.receipts.length === 0) {
    throw new Error("Intake snapshot carries no read receipts, so its freshness cannot be established.");
  }
  const observed = snapshot.receipts.map((receipt) => {
    const fetchedAtMs = Date.parse(receipt.fetchedAt);
    if (!Number.isFinite(fetchedAtMs)) {
      throw new Error(
        `Intake snapshot receipt ${receipt.endpoint} has an unparseable fetchedAt ${JSON.stringify(receipt.fetchedAt)}; re-run roadmap:intake-preflight.`,
      );
    }
    if (fetchedAtMs > nowMs) {
      throw new Error(
        `Intake snapshot receipt ${receipt.endpoint} was fetched at ${receipt.fetchedAt}, which is in the future relative to the shadow run clock ${now.toISOString()}.`,
      );
    }
    return { fetchedAt: receipt.fetchedAt, fetchedAtMs, endpoint: receipt.endpoint, domain: receipt.domain };
  });
  const oldestOf = (entries: readonly typeof observed[number][]) =>
    entries.reduce((left, right) => (right.fetchedAtMs < left.fetchedAtMs ? right : left));
  const stale = (entry: typeof observed[number]) => nowMs - entry.fetchedAtMs > SHADOW_SNAPSHOT_MAXIMUM_AGE_MS;

  // Coverage before recency: a domain that was never read cannot be stale, and answering "how old
  // is the oldest receipt" over a set that omits it would report freshness for a census that never
  // happened. Both refusals name the domain at fault, because that is the read an operator has to
  // go and re-run.
  // Two different rules, because the two kinds of domain carry different harm.
  //
  // NOVELTY domains (issues, comments) hard-fail. Novelty is decided against the marker index, and a
  // novelty verdict compiled over a census that never happened manufactures a duplicate
  // recommendation — the one harm this branch exists to avoid, since duplicates are what would
  // poison the corpus as calibration evidence.
  for (const domain of SHADOW_REQUIRED_RECEIPT_DOMAINS) {
    const forDomain = observed.filter((entry) => entry.domain === domain);
    if (forDomain.length === 0) {
      throw new Error(
        `Intake snapshot carries no ${domain} receipt, so the novelty decision would rest on a ` +
        `${domain} census that was never attested; re-run roadmap:intake-preflight.`,
      );
    }
    const oldestForDomain = oldestOf(forDomain);
    if (stale(oldestForDomain)) {
      throw new Error(
        `Intake snapshot ${domain} receipt ${oldestForDomain.endpoint} (fetched ${oldestForDomain.fetchedAt}) ` +
        `is older than the ${SHADOW_SNAPSHOT_MAXIMUM_AGE_MS} ms shadow consumption bound ` +
        `(age ${nowMs - oldestForDomain.fetchedAtMs} ms); re-run roadmap:intake-preflight.`,
      );
    }
  }

  // CLASSIFICATION domains (fields, relationships, project) degrade instead of refusing. The
  // decision reads Type / Priority / Effort / Horizon out of `fieldValues` unconditionally
  // (`intake-decision.ts` fieldValue), and it will keep doing so — a recommendation built on a
  // stale field read is still worth making. The check is therefore two-directional where the old
  // one was one-directional: a domain counts as attested only when the snapshot BOTH declares the
  // census complete AND carries a fresh receipt for it, so declaring a domain "incomplete" no
  // longer buys silence. Everything else is marked `assumed` and travels with the report.
  const classificationEvidence = Object.fromEntries(CLASSIFICATION_COVERAGE_DOMAINS.map((domain) => {
    const forDomain = observed.filter((entry) => entry.domain === domain);
    const declaredComplete = snapshot.coverage[domain] === "complete";
    const attested = declaredComplete && forDomain.length > 0 && !stale(oldestOf(forDomain));
    return [domain, attested ? "attested" : "assumed"] as const;
  })) as ClassificationEvidence;

  // Scope the terminal refusal to the novelty receipts. Round 5: the global `stale(oldest)` check
  // below fired first for a stale CLASSIFICATION receipt, so such a snapshot refused instead of
  // degrading — the `!stale(...)` term above was dead and the degrade path unreachable for the one
  // input it exists for. The reported window still spans every receipt; only what may *throw* is
  // narrowed, so a stale classification census now marks `assumed` and the run continues.
  const noveltyObserved = observed.filter((entry) =>
    (SHADOW_REQUIRED_RECEIPT_DOMAINS as readonly string[]).includes(entry.domain));
  const oldestNovelty = oldestOf(noveltyObserved);
  const oldest = oldestOf(observed);
  const newest = observed.reduce((left, right) => (right.fetchedAtMs > left.fetchedAtMs ? right : left));
  const oldestAgeMs = nowMs - oldest.fetchedAtMs;
  // Belt-and-braces on the novelty domains, which the per-domain loop above already bounded.
  if (stale(oldestNovelty)) {
    throw new Error(
      `Intake snapshot receipt ${oldestNovelty.endpoint} (fetched ${oldestNovelty.fetchedAt}) is older than the ` +
      `${SHADOW_SNAPSHOT_MAXIMUM_AGE_MS} ms shadow consumption bound (age ${nowMs - oldestNovelty.fetchedAtMs} ms); re-run roadmap:intake-preflight.`,
    );
  }
  return {
    oldestFetchedAt: oldest.fetchedAt,
    newestFetchedAt: newest.fetchedAt,
    receiptCount: observed.length,
    oldestAgeMs,
    classificationEvidence,
  };
}

/** Distinguish a snapshot that can no longer support a novelty verdict from an ambiguous match. */
function holdReason(snapshot: IntakeSnapshotV1, sourceFingerprint: string): IntakeShadowHoldReason {
  // Shared with `canonicalMatch`: the reason an operator reads and the result the decision compiled
  // are two readings of one rule, so neither restates it.
  if (noveltyRevalidationFailed(snapshot, sourceFingerprint)) return "novelty_revalidation_failed";
  return "ambiguous_match";
}

function competingIssues(snapshot: IntakeSnapshotV1, numbers: readonly number[]): IntakeShadowCompetingIssue[] {
  return numbers.flatMap((number) => {
    const issue = snapshot.issues.find((entry) => entry.number === number);
    return issue === undefined
      ? []
      : [{ number: issue.number, title: issue.title, state: issue.state, updatedAt: issue.updatedAt }];
  });
}

function deniedActions(actions: readonly IntakeActionDecision[]): IntakeShadowDeniedAction[] {
  return actions.flatMap((action) => {
    if (action.disposition === "automatic_safe") return [];
    return [{
      action: action.action,
      disposition: action.disposition,
      proposed: action.proposed,
      targetIssueNumber: action.targetIssueNumber,
      requiredCapabilities: action.requiredCapabilities,
      rationale: action.rationale,
      deniedReason: intakeDenialReason(action.disposition),
    }];
  });
}

function presentCandidates(input: {
  readonly envelope: OutcomeEnvelope;
  readonly snapshot: IntakeSnapshotV1;
  readonly decision: IntakeDecision;
  readonly assessment: IntakeAssessment;
  readonly evidenceCoverage: IntakeEvidenceCoverage | null;
  readonly active: OutcomeEnvelope["candidates"];
  readonly record: (kind: IntakeShadowEventKind, detail: string) => void;
}): IntakeShadowCandidate[] {
  return input.decision.candidates.map((entry) => {
    const candidate = input.active.find((item) => item.sourceFingerprint === entry.sourceFingerprint);
    if (candidate === undefined) throw new Error(`Shadow report is missing envelope candidate ${entry.sourceFingerprint}.`);
    const intendedButDenied = deniedActions(entry.actions);
    if (entry.actions.some((action) => action.action === "replay_no_op")) {
      input.record("replay_recorded", `${entry.sourceFingerprint} is already consumed by issue #${entry.canonicalIssueNumber ?? 0}.`);
      return { sourceFingerprint: entry.sourceFingerprint, matchResult: entry.matchResult, presentation: "replay_no_op" as const, draft: null, hold: null, intendedButDenied };
    }
    const holdAction = entry.actions.find((action) => action.action === "hold_invalid");
    if (holdAction !== undefined) {
      const heldCompetingIssues = competingIssues(input.snapshot, entry.competingIssueNumbers);
      const rationale = holdAction?.rationale ?? "The decision holds this candidate at zero writes.";
      const hold: IntakeShadowHold = {
        reason: holdReason(input.snapshot, entry.sourceFingerprint),
        issue: null,
        competingIssueNumbers: entry.competingIssueNumbers,
        competingIssues: heldCompetingIssues,
        evidenceIds: holdAction?.evidenceIds ?? [],
        rationale,
      };
      input.record(
        "hold_presented",
        `${entry.sourceFingerprint} held as ${hold.reason}; ` +
        `${hold.issue === null ? "no fileable issue payload rendered" : "fileable issue payload rendered"}.`,
      );
      return { sourceFingerprint: entry.sourceFingerprint, matchResult: entry.matchResult, presentation: "hold" as const, draft: null, hold, intendedButDenied };
    }
    // New candidates draft an issue with model annotations; marker matches draft an evidence comment. Both are
    // fileable by hand from the draft alone, with no field reconstructed.
    const draft = buildIntakeIssueDraft({ envelope: input.envelope, candidate, decision: input.decision,
      assessmentMatch: input.assessment.candidates.find((item) => item.sourceFingerprint === entry.sourceFingerprint)?.match,
      evidenceCoverage: input.evidenceCoverage });
    input.record(
      "draft_rendered",
      `${entry.sourceFingerprint} drafted to ${draft.intendedAction ?? "no_consumption_action"}` +
      // The append target travels with the intent: an operator reading the event log alone must be
      // able to see which existing issue the evidence comment belongs on.
      `${draft.canonicalIssueNumber === null ? "" : ` on issue #${draft.canonicalIssueNumber}`}; ` +
      `authorized as ${draft.primaryAction ?? "recommendation_only"}.`,
    );
    return { sourceFingerprint: entry.sourceFingerprint, matchResult: entry.matchResult, presentation: "draft" as const, draft, hold: null, intendedButDenied };
  });
}

export function intakeShadowReportJson(report: IntakeShadowReport): string {
  return prettyCanonicalJson(report);
}

/** Optional evaluator telemetry annotates the draft; absent or malformed telemetry never gates it. */
function readEvidenceCoverage(assessmentPath: string, assessmentSha256: string, repoRoot: string): IntakeEvidenceCoverage | null {
  let raw;
  try {
    raw = JSON.parse(readFileSync(`${assessmentPath}.evidence-view.json`, "utf8"));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : { bound: false };
  }
  try {
    if (raw.schemaVersion !== "github-issue-roadmap-assessment-evidence-view/v1" ||
        typeof raw.assessmentTarget !== "string" ||
        realpathSync(resolve(repoRoot, raw.assessmentTarget)) !== assessmentPath ||
        raw.assessmentSha256 !== assessmentSha256) return { bound: false };
    const { bodiesIncluded, bodiesOmitted, bodiesExcerpted } = raw.view;
    const { attentionRequestsOutsideView, citationsOutsideView } = raw;
    if (!Number.isSafeInteger(bodiesIncluded) || bodiesIncluded < 0 ||
        !Number.isSafeInteger(bodiesOmitted) || bodiesOmitted < 0 ||
        !Number.isSafeInteger(bodiesIncluded + bodiesOmitted) ||
        (bodiesExcerpted !== undefined && (!Array.isArray(bodiesExcerpted) ||
          !bodiesExcerpted.every((number: unknown) => typeof number === "number" && Number.isSafeInteger(number) && number > 0) ||
          new Set(bodiesExcerpted).size !== bodiesExcerpted.length || bodiesExcerpted.length > bodiesIncluded)) ||
        !Array.isArray(attentionRequestsOutsideView) ||
        !attentionRequestsOutsideView.every((number: unknown) => typeof number === "number" && Number.isSafeInteger(number) && number > 0) ||
        !Array.isArray(citationsOutsideView) || !citationsOutsideView.every((citation: unknown) => typeof citation === "string")) return { bound: false };
    return { bodiesIncluded, bodiesOmitted, ...(bodiesExcerpted === undefined ? {} : { bodiesExcerpted: bodiesExcerpted.length }),
      attentionRequestsOutsideView, citationsOutsideView };
  } catch {
    return { bound: false };
  }
}

/**
 * Compile the real decision for one bound evidence stack and present it as drafts and holds.
 *
 * Every boundary the retired review root enforced is preserved here: contextual JSON-read errors
 * naming the failing file, output-path confinement, input/output path distinctness, the
 * triple-bound assessment parse, optional capability-manifest semantics, and an atomic artifact
 * write.
 */
export function runIntakeShadow(input: IntakeShadowRunInput): IntakeShadowRunResult {
  if (typeof input.dispositionHistory !== "function") {
    throw new Error("disposition_history_unavailable: no history lookup injected");
  }
  const repoRoot = input.repoRoot;
  const now = input.now ?? new Date();
  const attemptedAt = Number.isFinite(now.getTime()) ? now.toISOString() : new Date().toISOString();
  const log = input.log ?? ((line: string) => console.log(line));
  const events: IntakeShadowEvent[] = [];
  const record = (kind: IntakeShadowEventKind, detail: string): void => {
    events.push({ kind, detail });
  };

  let stage: IntakeAttemptStage = "input_paths";
  let bound = false;
  const availableBindings: {
    candidate: Readonly<{ locator: string; envelope: OutcomeEnvelope }> | null;
    snapshot: IntakeAttemptRecord["bindings"]["snapshot"];
    assessment: IntakeAssessment | null;
  } = { candidate: null, snapshot: null, assessment: null };

  const execute = (): IntakeShadowRunResult => {

  if (input.existence === undefined || input.existence.trim() === "") {
    throw new Error("Shadow intake requires an existence record path.");
  }
  if (input.verifiedOriginMainSha === undefined || input.verifiedOriginMainSha.trim() === "") {
    throw new Error("Shadow intake requires the verified origin/main SHA.");
  }

  const paths = {
    candidate: canonicalRepoInputFile(repoRoot, input.candidate, "--candidate"),
    snapshot: canonicalRepoInputFile(repoRoot, input.snapshot, "--snapshot"),
    assessment: resolve(repoRoot, input.assessment),
    existence: canonicalRepoInputFile(repoRoot, input.existence, "--existence"),
    capabilities: input.capabilities === undefined || input.capabilities === null ? null : resolve(repoRoot, input.capabilities),
    out: assertRoadmapArtifactOutputPath(input.out, repoRoot),
  };
  assertDistinctRoadmapArtifactPaths([
    { label: "--candidate", path: paths.candidate },
    { label: "--snapshot", path: paths.snapshot },
    { label: "--assessment", path: paths.assessment },
    { label: "--existence", path: paths.existence },
    ...(paths.capabilities === null ? [] : [{ label: "--capabilities", path: paths.capabilities }]),
    { label: "--out", path: paths.out },
  ], repoRoot);

  stage = "candidate_read";
  const rawCandidate = readJson(paths.candidate, "Outcome candidate");
  // The same 64 KiB / 16 KiB / five-candidate budgets the default path applies. Shadow mode
  // compiles the real decision, so an envelope the enabled path would refuse must not become a
  // draft here either.
  stage = "candidate_validate";
  assertIntakeEnvelopeByteBudgets(rawCandidate);
  const envelope = parseOutcomeEnvelope(rawCandidate);
  const history = input.dispositionHistory(input.verifiedOriginMainSha, { repoRoot });
  assertEffectiveIntakeEnvelopeBudgets(rawCandidate, envelope, history);
  const selection = effectiveOutcomeCandidates(envelope, history);
  availableBindings.candidate = {
    locator: relative(repoRoot, paths.candidate).replace(/\\/g, "/"),
    envelope,
  };
  record("input_read", `Outcome candidate: ${envelope.candidates.length} candidate(s).`);
  stage = "snapshot_read";
  const rawSnapshot = readJson(paths.snapshot, "Intake snapshot");
  stage = "snapshot_validate";
  const snapshot = parseIntakeSnapshotV1(rawSnapshot);
  availableBindings.snapshot = {
    locator: relative(repoRoot, paths.snapshot).replace(/\\/g, "/"),
    contentSha256: snapshot.contentSha256,
  };
  record("input_read", `Intake snapshot: ${snapshot.issues.length} canonical issue(s).`);
  stage = "snapshot_freshness";
  const observationWindow = assertIntakeSnapshotFreshForShadow(snapshot, now);
  // The window spans EVERY receipt; the consumption bound is verified for the novelty domains only,
  // because a classification domain degrades rather than refusing. So `oldestAgeMs` can legitimately
  // exceed the bound when a classification census is old — that is the degrade path working, and the
  // affected domain is named `assumed` in `classificationEvidence`. `generatedAt` stays provenance,
  // not evidence.
  record(
    "snapshot_freshness_verified",
    `Receipt observation window ${observationWindow.oldestFetchedAt} to ${observationWindow.newestFetchedAt} ` +
    `across ${observationWindow.receiptCount} receipt(s); oldest read ${observationWindow.oldestAgeMs} ms before ` +
    `consumption at ${now.toISOString()} (snapshot generatedAt ${snapshot.generatedAt} is informational).`,
  );
  const assumedDomains = CLASSIFICATION_COVERAGE_DOMAINS
    .filter((domain) => observationWindow.classificationEvidence[domain] === "assumed");
  record(
    "classification_evidence_qualified",
    assumedDomains.length === 0
      ? `Every classification domain (${CLASSIFICATION_COVERAGE_DOMAINS.join(", ")}) is attested by a fresh receipt.`
      : `Classification data assumed without an attested fresh census for: ${assumedDomains.join(", ")}. ` +
        `Recommendations below still read those fields; the report records each domain's state so a ` +
        `calibration pass can separate them from fully attested recommendations.`,
  );
  stage = "assessment_read";
  let assessmentBytesSha256 = "";
  const rawAssessment = readJson(paths.assessment, "Intake assessment", (bytes) => {
    assessmentBytesSha256 = createHash("sha256").update(bytes).digest("hex");
  });
  stage = "assessment_validate";
  const assessment = parseIntakeAssessment(rawAssessment, envelope, snapshot, input.expectedAssessmentStack, history);
  availableBindings.assessment = assessment;
  record("input_read", `Intake assessment bound to ${assessment.candidateSha256}.`);
  stage = "capability_read";
  let existenceRecord: unknown;
  try {
    existenceRecord = JSON.parse(readFileSync(paths.existence, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    existenceRecord = error instanceof SyntaxError
      ? { kind: "existence_unreadable_record", detail }
      : { kind: "existence_read_failure", detail };
  }
  record("input_read", `Existence record read for verified origin/main ${input.verifiedOriginMainSha}.`);
  stage = "capability_read";
  const rawCapabilityManifest = paths.capabilities === null
    ? null
    : readJson(paths.capabilities, "Capability manifest");
  stage = "capability_validate";
  const capabilityManifest = rawCapabilityManifest === null
    ? null
    : parseIntakeCapabilityManifest(rawCapabilityManifest);
  if (capabilityManifest !== null) record("input_read", `Capability manifest ${capabilityManifest.manifestId}.`);

  stage = "decision_compile";
  const decision = compileIntakeDecision({
    envelope, snapshot, assessment, capabilityManifest, existenceRecord,
    dispositionHistory: history,
    verifiedOriginMainSha: input.verifiedOriginMainSha,
  });
  const observationOperands = deriveIntakeObservationOperands({
    envelope, snapshot, assessment, decision, existenceRecord,
    dispositionHistory: history,
    verifiedOriginMainSha: input.verifiedOriginMainSha,
  });
  bound = true;
  record("decision_compiled", `${decision.candidates.length} evidence-bound candidate decision(s).`);
  const candidates = presentCandidates({ envelope, snapshot, decision, assessment, active: selection.active,
    evidenceCoverage: readEvidenceCoverage(paths.assessment, assessmentBytesSha256, repoRoot), record });

  const report: IntakeShadowReport = {
    schemaVersion: INTAKE_SHADOW_SCHEMA,
    // The run's own clock. `decision.generatedAt` is the assessment's timestamp and stays on the
    // embedded decision; a report that borrowed it would date the presentation to the assessment.
    generatedAt: now.toISOString(),
    repository: decision.repository,
    capabilityManifestId: decision.capabilityManifestId,
    snapshotGeneratedAt: snapshot.generatedAt,
    consumedAt: now.toISOString(),
    classificationEvidence: observationWindow.classificationEvidence,
    decision,
    assessmentInputSha256: canonicalJsonSha256(rawAssessment),
    candidates,
    skipped: intakeDispositionSkips(envelope, history),
  };
  writeRoadmapArtifactAtomically(paths.out, intakeShadowReportJson(report));
  const relativeOut = relative(repoRoot, paths.out).replace(/\\/g, "/");
  record("artifact_written", relativeOut);

  const decisionSha256 = canonicalJsonSha256(decision);
  const candidateLocator = relative(repoRoot, paths.candidate).replace(/\\/g, "/");
  const snapshotLocator = relative(repoRoot, paths.snapshot).replace(/\\/g, "/");
  bankIntakeObservations(decision.candidates.map((candidate) => ({
      repoRoot,
      candidate: {
        locator: candidateLocator,
        contentSha256: decision.candidateSha256,
        sourceFingerprint: candidate.sourceFingerprint,
      },
      snapshot: {
        locator: snapshotLocator,
        contentSha256: decision.snapshotContentSha256,
      },
      decisionSha256,
      assessmentSha256: decision.assessmentSha256,
      assessmentStackSha256: decision.assessmentStackSha256,
      producerKind: envelope.producer.kind,
      observedMatch: candidate.matchResult,
      operands: observationOperands.get(candidate.sourceFingerprint)!,
      observedAt: now.toISOString(),
    })));

  const drafted = candidates.flatMap((entry) => entry.draft === null ? [] : [entry.draft]);
  const counts = {
    drafts: candidates.filter((entry) => entry.presentation === "draft").length,
    creates: drafted.filter((entry) => entry.intendedAction === "create_issue").length,
    appends: drafted.filter((entry) => entry.intendedAction === "append_evidence").length,
    appendTargets: drafted.flatMap((entry) => entry.canonicalIssueNumber === null ? [] : [entry.canonicalIssueNumber]),
    holds: candidates.filter((entry) => entry.presentation === "hold").length,
    replays: candidates.filter((entry) => entry.presentation === "replay_no_op").length,
    denied: candidates.reduce((total, entry) => total + entry.intendedButDenied.length, 0),
  };
  const summary = [
    `Compiled ${candidates.length} shadow candidate decision(s) to ${relativeOut}; ` +
    `${capabilityManifest === null ? "no capability manifest, automatic writes denied" : `manifest ${capabilityManifest.manifestId}`}.`,
    `${counts.drafts} draft(s) (${counts.creates} new issue, ${counts.appends} evidence comment` +
    `${counts.appendTargets.length === 0 ? "" : ` on issue ${counts.appendTargets.map((number) => `#${number}`).join(", ")}`}), ` +
    `${counts.holds} hold(s), ${counts.replays} replay(s), ${selection.dispositioned.length} dispositioned skip(s), ` +
    `${counts.denied} intended-but-denied action(s); shadow mode wrote no GitHub state.`,
  ];
  for (const line of summary) log(line);

  return { outputPath: paths.out, report, events, summary };
  };

  try {
    return execute();
  } catch (error) {
    if (!bound) {
      bankIntakeAttempt({
        repoRoot,
        stage,
        attemptedAt,
        bindings: {
          candidate: availableBindings.candidate === null ? null : {
            locator: availableBindings.candidate.locator,
            contentSha256: canonicalJsonSha256(availableBindings.candidate.envelope),
            producerKind: availableBindings.candidate.envelope.producer.kind,
          },
          snapshot: availableBindings.snapshot,
          assessment: availableBindings.assessment === null ? null : {
            contentSha256: intakeAssessmentSha256(availableBindings.assessment),
            stackSha256: assessmentStackSha256(availableBindings.assessment.stack),
          },
        },
        failure: intakeAttemptFailure(stage),
      });
    }
    throw error;
  }
}

function canonicalRepoInputFile(repoRoot: string, value: string, flag: string): string {
  const root = realpathSync(resolve(repoRoot));
  const path = realpathSync(resolve(root, value));
  const fromRoot = relative(root, path);
  if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error(`${flag} must resolve to a regular file inside the repository.`);
  }
  if (!statSync(path).isFile()) {
    throw new Error(`${flag} must resolve to a regular file inside the repository.`);
  }
  return path;
}
