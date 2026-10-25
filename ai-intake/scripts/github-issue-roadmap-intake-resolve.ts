import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  INTAKE_APPROVAL_LEDGER_SCHEMA, assertNoDispositionBeforeWrite, eventWrite, firstCreateAttemptAt, proveUnresolvedCreate, reconcileCreate, indexHistory, resolveDurableState,
  type AbandonedExecutionEvent, type Abandonment, type ApprovalExecutionEvent, type DurableState, type HistoricalOperation, type HistoryIdentity,
  type LegacyVerifiedExecutionEvent,
} from "./github-issue-roadmap-intake-apply";
import {
  acquireExecutionClaim, appendJournal, ExecutionOwnershipError, foldRepository, JournalWriteError, readJournal, resolveJournalPath,
} from "./lib/github-issue-roadmap/intake-execution-journal";
import { summarizeExecutionHistory } from "./lib/github-issue-roadmap/intake-execution-summary";
import { createGitHubIntakeApprovalTransport, type ClassificationReadPort, type FencedIntakeApprovalTransport } from "./lib/github-issue-roadmap/github-intake-approval-transport";
import { confirmOwnershipLive, proveCreateOwnership, type OwnershipIssueReadPort, type OwnershipLiveIssue, type OwnershipRefusal } from "./lib/github-issue-roadmap/intake-create-reconciliation";
import { parseIntakeSnapshotV1 } from "./lib/github-issue-roadmap/intake-snapshot";
import { intakeSnapshotCoverageSha256 } from "./lib/github-issue-roadmap/intake-assessment";
import { canonicalJsonSha256, sha256Bytes } from "./lib/github-issue-roadmap/canonical-json";
import { compareLegacyClassification, parseLegacyRequested, type LegacyClassification } from "./lib/github-issue-roadmap/intake-legacy-verification";
import { dispositionHistoryRef } from "./lib/github-issue-roadmap/disposition-history";

const USAGE = `Usage:
  roadmap:intake-resolve status --repository=Owner/repo [--source-fingerprint=F --action=create_issue|append_evidence [--emission-content-sha256=SHA256]]
  roadmap:intake-resolve abandon --repository=Owner/repo --source-fingerprint=F --action=create_issue|append_evidence --expected-state=STATE --reason="..." [--emission-content-sha256=SHA256] [--execute]
  roadmap:intake-resolve reconcile --repository=Owner/repo --source-fingerprint=F --action=create_issue --expected-state=intent_unknown|unresolved_unknown|unresolved_partial --census=<intake-snapshot.json> --run-id=<id> [--origin-main-sha=SHA] [--execute]
  roadmap:intake-resolve verify-legacy --repository=Owner/repo (--source-fingerprint=F | --all-legacy) --census=<intake-snapshot.json> --run-id=<id> [--execute]`;
const ABANDONABLE_STATES: readonly Abandonment["priorState"][] = ["intent_unknown", "primary_unverified",
  "classification_failed", "unresolved_unknown", "unresolved_partial", "legacy_unverified"];

class UsageError extends Error {}

function parseArguments(argv: readonly string[]) {
  const [command, ...flags] = argv;
  if (command !== "status" && command !== "abandon" && command !== "reconcile" && command !== "verify-legacy") throw new UsageError();
  const values = new Map<string, string>();
  const allowed = command === "status" ? ["repository", "source-fingerprint", "action", "emission-content-sha256"] : command === "abandon"
    ? ["repository", "source-fingerprint", "action", "expected-state", "reason", "execute", "emission-content-sha256"]
    : command === "verify-legacy" ? ["repository", "source-fingerprint", "all-legacy", "census", "run-id", "execute"]
    : ["repository", "source-fingerprint", "action", "expected-state", "census", "run-id", "origin-main-sha", "execute"];
  for (const flag of flags) {
    const match = /^--([^=]+)=([\s\S]*)$/.exec(flag);
    const booleanFlag = flag === "--execute" || flag === "--all-legacy";
    const key = booleanFlag ? flag.slice(2) : match?.[1];
    const value = booleanFlag ? "true" : match?.[2];
    if (key === undefined || value === undefined || !allowed.includes(key) || values.has(key)
      || value.trim() === "" || ((key === "execute" || key === "all-legacy") && !booleanFlag)) throw new UsageError();
    values.set(key, value);
  }
  if (command === "reconcile" && values.get("action") === "append_evidence") {
    throw new UsageError("append operations have no marker proof; use abandon or repair by hand");
  }
  const required = allowed.filter((key) => key !== "execute" && key !== "emission-content-sha256" && key !== "origin-main-sha"
    && !(command === "status" && key !== "repository") && !(command === "verify-legacy" && ["source-fingerprint", "all-legacy"].includes(key)));
  if (required.some((key) => !values.has(key))) throw new UsageError();
  if (command === "verify-legacy" && values.has("source-fingerprint") === values.has("all-legacy")) throw new UsageError();
  const repository = values.get("repository")!;
  if (!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(repository)) throw new UsageError();
  const action = command === "verify-legacy" ? "create_issue" : values.get("action");
  if ((command !== "status" || action !== undefined) && action !== "create_issue" && action !== "append_evidence") throw new UsageError();
  if (command === "status" && values.has("source-fingerprint") !== values.has("action")) throw new UsageError();
  const emissionContentSha256 = values.get("emission-content-sha256");
  const originMainSha = values.get("origin-main-sha");
  if (originMainSha !== undefined && !/^[0-9a-f]{40}$/.test(originMainSha)) throw new UsageError("--origin-main-sha requires a full lowercase commit SHA.");
  if (emissionContentSha256 !== undefined && (action !== "append_evidence" || !/^[0-9a-f]{64}$/.test(emissionContentSha256))) {
    throw new UsageError("--emission-content-sha256 requires --action=append_evidence and a lowercase SHA-256 digest.");
  }
  if (command === "reconcile" && (!["intent_unknown", "unresolved_unknown", "unresolved_partial"].includes(values.get("expected-state")!)
    || values.get("run-id")!.length > 200 || /[\r\n]/.test(values.get("run-id")!))) throw new UsageError();
  if (command === "abandon" && (!ABANDONABLE_STATES.some((state) => state === values.get("expected-state"))
    || values.get("reason")!.length > 500 || /[\r\n]/.test(values.get("reason")!))) throw new UsageError();
  if (command === "verify-legacy" && (values.get("run-id")!.length > 200 || /[\r\n]/.test(values.get("run-id")!))) throw new UsageError();
  return { command, repository, action: action as HistoryIdentity["action"], emissionContentSha256, originMainSha,
    sourceFingerprint: values.get("source-fingerprint")!, expectedState: values.get("expected-state")!,
    reason: values.get("reason")!, censusPath: values.get("census")!, runId: values.get("run-id")!, execute: values.has("execute"), allLegacy: values.has("all-legacy") };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function originalRow(value: unknown): Record<string, unknown> | null {
  const row = object(value);
  return row?.kind === "legacy_import" ? object(row.row) : row;
}

function resolveOperatorState(index: ReturnType<typeof indexHistory>, identity: HistoryIdentity): DurableState {
  // Resolve against the full fingerprint history: selection must not hide safety barriers.
  const state = resolveDurableState(index, identity);
  if (identity.action === "append_evidence" && identity.emissionContentSha256 !== undefined
    && !state.operations.some((operation) => operation.action === "append_evidence"
      && operation.event !== null && operation.event.event !== "legacy_verified"
      && operation.event.emissionContentSha256 === identity.emissionContentSha256)) {
    throw new Error("No append operation matches --emission-content-sha256 for this fingerprint.");
  }
  if (state.kind === "multiple_actions" && identity.action === "append_evidence"
    && new Set(state.operations.filter((operation) => operation.action === "append_evidence")
      .map((operation) => operation.event?.event === "legacy_verified" ? undefined : operation.event?.emissionContentSha256).filter((emission) => emission != null)).size > 1) {
    throw new Error("Selection refused: current state multiple_actions. Pass --emission-content-sha256 to select an append emission; unfinished or conflicting history still governs this fingerprint.");
  }
  return state;
}

function status(repository: string, journalPath: string, now: Date, identity?: HistoryIdentity) {
  const journal = readJournal(journalPath);
  const index = indexHistory(journal.records, journal.tail);
  const inRepository = (repo: string | null) => repo === null || foldRepository(repo) === foldRepository(repository);
  const selection = identity === undefined ? undefined : resolveOperatorState(index, identity);
  // Scope the already-built index without renumbering rows or changing legacy evidence.
  const summary = summarizeExecutionHistory({ ...index,
    staged: new Map([...index.staged].filter(([, operation]) => inRepository(operation.repository))),
    stagedByEntry: new Map([...index.stagedByEntry].filter(([, actions]) =>
      [...actions.values()].some((operation) => inRepository(operation.repository)))),
    legacy: new Map([...index.legacy].map(([fingerprint, operations]) =>
      [fingerprint, operations.filter((operation) => inRepository(operation.repository))])),
    malformed: index.malformed.filter((problem) => inRepository(problem.repository)),
    conflicts: index.conflicts.filter((conflict) => inRepository(conflict.left.repository)),
  }, now, repository);
  return { repository, journalPath, journalTail: { present: journal.tail !== null }, summary, operations: summary.operations,
    ...(selection === undefined ? {} : { selection }) };
}

function abandonmentEvent(state: DurableState, reason: string, now: Date): AbandonedExecutionEvent {
  switch (state.kind) {
    case "intent_unknown": case "primary_unverified": case "classification_failed":
    case "unresolved_unknown": case "unresolved_partial": case "legacy_unverified": break;
    case "malformed": case "conflict":
      throw new Error(`Abandon refused: current state ${state.kind}. Inspect \`status\` output for this fingerprint and repair the journal by hand after confirming no intake run is live.`);
    case "multiple_actions":
      throw new Error(`Abandon refused: current state multiple_actions. Pass \`--action\` to select one of: ${[...new Set(state.operations.map((operation) => operation.action).filter((action) => action !== null))].sort().join(", ")}.`);
    default: throw new Error(`Abandon refused: current state ${state.kind}${state.kind === "abandoned" ? " (already abandoned)" : ""}.`);
  }
  const operation = state.operation;
  const latest = operation.history.at(-1)!;
  const raw = originalRow(latest.value);
  const hash = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : null;
  const event = operation.provenance === "staged" && operation.event.event !== "legacy_verified" ? operation.event : null;
  const abandonment: Abandonment = { reason, operator: userInfo().username, priorState: state.kind,
    priorEventRowNumber: latest.rowNumber, at: now.toISOString() };
  // Null legacy bindings and payloads record what was unknown; they authorize no GitHub effect.
  return {
    schemaVersion: INTAKE_APPROVAL_LEDGER_SCHEMA, event: "abandoned", appliedAt: abandonment.at,
    repository: state.scope.repository, sourceFingerprint: state.scope.sourceFingerprint, action: state.scope.action!,
    emissionContentSha256: event?.emissionContentSha256 ?? hash(raw?.emissionContentSha256),
    decisionContentSha256: event?.decisionContentSha256 ?? hash(raw?.decisionContentSha256),
    payload: event?.payload ?? { issue: null, evidenceComment: null, closeIssue: null },
    classifications: operation.classifications, ...retainedResult(state, operation), abandonment,
  };
}

function retainedResult(state: DurableState, operation: HistoricalOperation) {
  if (operation.provenance === "staged") return operation.result;
  // Legacy observations can split identities across rows. Preserve every known field.
  const result = { ...operation.result };
  for (const prior of state.operations) {
    if (prior.action !== null && prior.action !== state.scope.action) continue;
    for (const field of ["issueNumber", "issueId", "commentId"] as const) {
      if (field === "issueNumber") result.issueNumber ??= prior.result.issueNumber;
      else result[field] ??= prior.result[field];
    }
  }
  return result;
}

type DispositionWriteGuardInput = Parameters<typeof assertNoDispositionBeforeWrite>[1];

interface ResolveCliInput extends Omit<DispositionWriteGuardInput, "trustedCurrentOriginMainSha" | "stableOutcomeId"> {
  readonly argv: readonly string[];
  readonly now?: Date;
  readonly log?: (line: string) => void;
  readonly error?: (line: string) => void;
  readonly operatorToken?: string;
  readonly transport?: FencedIntakeApprovalTransport & OwnershipIssueReadPort & Partial<ClassificationReadPort>;
}

function unresolvedCreate(journal: ReturnType<typeof readJournal>, args: ReturnType<typeof parseArguments>) {
  const state = resolveDurableState(indexHistory(journal.records, journal.tail), args);
  if (state.kind !== args.expectedState) {
    throw new Error(`Reconcile refused: current state ${state.kind}; expected state ${args.expectedState}.`);
  }
  if (state.kind !== "intent_unknown" && state.kind !== "unresolved_unknown" && state.kind !== "unresolved_partial") {
    throw new Error(`Reconcile refused: current state ${state.kind}.`);
  }
  return state;
}

async function reconcile(args: ReturnType<typeof parseArguments>, input: ResolveCliInput): Promise<number> {
  const log = input.log ?? console.log;
  const refuse = (refusal: OwnershipRefusal) => { log(JSON.stringify(refusal, null, 2)); return 1; };
  const token = input.operatorToken ?? process.env.ROADMAP_SHADOW_PUBLISH_TOKEN;
  const tokenPresent = token !== undefined && token.trim() !== "";
  if (!args.execute && tokenPresent) throw new Error("ROADMAP_SHADOW_PUBLISH_TOKEN is allowed only for an explicit --execute invocation.");
  if (args.execute && !tokenPresent) throw new Error("Set ROADMAP_SHADOW_PUBLISH_TOKEN only for this explicit --execute invocation.");
  const journalPath = resolveJournalPath(args.repository);
  // Own the journal before reading either evidence or history. Preview is entirely read-only.
  const claim = args.execute ? acquireExecutionClaim(journalPath, { mode: "resolve" }) : undefined;
  let failed = false;
  try {
    const state = unresolvedCreate(readJournal(journalPath), args);
    firstCreateAttemptAt(state);
    let census;
    let censusBinding;
    try {
      const artifactPath = resolve(args.censusPath);
      const bytes = readFileSync(artifactPath);
      census = parseIntakeSnapshotV1(JSON.parse(bytes.toString("utf8")));
      censusBinding = { artifactPath, artifactSha256: sha256Bytes(bytes), contentSha256: census.contentSha256,
        coverageSha256: intakeSnapshotCoverageSha256(census) };
    } catch (cause) {
      return refuse({ kind: "refusal", reason: "binding_mismatch", detail: cause instanceof Error ? cause.message : String(cause) });
    }
    const reconciliationInput = { identity: args, priorState: state, census, censusBinding };
    if (claim === undefined) {
      const proof = proveUnresolvedCreate(reconciliationInput);
      if (proof.kind === "refusal") return refuse(proof);
      log(JSON.stringify(proof, null, 2)); return 0;
    }
    const proof = proveUnresolvedCreate(reconciliationInput);
    if (proof.kind === "refusal") return refuse(proof);
    if (args.originMainSha !== undefined && dispositionHistoryRef(args.originMainSha, input) !== args.originMainSha) {
      throw new Error(`Trusted current origin/main SHA is not a local commit: ${args.originMainSha}.`);
    }
    const result = await reconcileCreate({ ...reconciliationInput,
      transport: input.transport ?? createGitHubIntakeApprovalTransport({ token: token! }), claim,
      fence: () => claim.withOwnership(() => {}),
      recordTransition: (transition: ApprovalExecutionEvent) => claim.withOwnership(() => appendJournal(journalPath, transition)),
      readCurrentJournal: () => readJournal(journalPath), now: input.now, runId: args.runId, operator: userInfo().username,
      // The census proves outcome identity. An optional run pin is verified above;
      // invocations without it retain the live origin/main-only check.
      beforeWrite: () => assertNoDispositionBeforeWrite(eventWrite(state.operation.event), {
        repoRoot: input.repoRoot, runGit: input.runGit, dispositionHistory: input.dispositionHistory,
        trustedCurrentOriginMainSha: args.originMainSha,
        stableOutcomeId: proof.censusMarker.stableOutcomeId,
      }),
      preflight: true, onReconciled: (predatesAttempt) => {
        if (predatesAttempt) log("predatesAttempt: true — the owned issue predates the first recorded attempt.");
      },
    });
    if (result.kind === "refused") return refuse({ ...result, kind: "refusal" });
    if (!("reconciled" in result)) {
      log(JSON.stringify({ repository: args.repository, journalPath, execute: true,
        state: result.terminal.event, event: result.terminal }, null, 2));
      return 1;
    }
    const { terminal, predatesAttempt, reconciled: event } = result;
    log(JSON.stringify({ repository: args.repository, journalPath, execute: true, state: terminal.event,
      censusPath: proof.censusBinding.artifactPath, predatesAttempt, event: terminal, reconciliation: event.reconciliation }, null, 2));
    return terminal.event === "complete" ? 0 : 1;
  } catch (cause) { failed = true; throw cause; }
  finally {
    try { claim?.release(); }
    catch (cause) { if (!failed) throw cause; }
  }
}

async function verifyLegacy(args: ReturnType<typeof parseArguments>, input: ResolveCliInput): Promise<number> {
  const token = input.operatorToken ?? process.env.ROADMAP_SHADOW_PUBLISH_TOKEN;
  const tokenPresent = token !== undefined && token.trim() !== "";
  if (!args.execute && tokenPresent) throw new Error("ROADMAP_SHADOW_PUBLISH_TOKEN is allowed only for an explicit --execute invocation.");
  if (args.execute && !tokenPresent) throw new Error("Set ROADMAP_SHADOW_PUBLISH_TOKEN only for this explicit --execute invocation.");
  const transport = args.execute ? input.transport ?? createGitHubIntakeApprovalTransport({ token: token! }) : undefined;
  if (transport !== undefined && transport.readClassifications === undefined) {
    throw new Error("verification_unavailable: transport cannot read classifications");
  }
  const journalPath = resolveJournalPath(args.repository);
  // Acquire before reading history or census; all later dispatches/appends revalidate ownership.
  const claim = args.execute ? acquireExecutionClaim(journalPath, { mode: "resolve" }) : undefined;
  let failed = false;
  try {
    const journal = readJournal(journalPath);
    const index = indexHistory(journal.records, journal.tail);
    const identityFor = (sourceFingerprint: string) => ({ repository: args.repository, sourceFingerprint, action: "create_issue" as const });
    const selected = args.allLegacy ? [...index.legacy.keys()].flatMap((sourceFingerprint) => {
      const state = resolveDurableState(index, identityFor(sourceFingerprint));
      if (state.kind !== "legacy_unverified") return [];
      const first = Math.min(...state.operations.flatMap((operation) => operation.history).map((row) => {
        const at = originalRow(row.value)?.appliedAt;
        return typeof at === "string" && Number.isFinite(Date.parse(at)) ? Date.parse(at) : Infinity;
      }));
      return [{ sourceFingerprint, first, rowNumber: state.operation.history.at(-1)!.rowNumber }];
    }).sort((a, b) => a.first - b.first || a.rowNumber - b.rowNumber).map((row) => row.sourceFingerprint) : [args.sourceFingerprint];
    const artifactPath = resolve(args.censusPath);
    const bytes = readFileSync(artifactPath);
    const census = parseIntakeSnapshotV1(JSON.parse(bytes.toString("utf8")));
    const censusBinding = { artifactPath, artifactSha256: sha256Bytes(bytes), contentSha256: census.contentSha256,
      coverageSha256: intakeSnapshotCoverageSha256(census) };
    const censusEvidence = { basename: basename(artifactPath), artifactSha256: censusBinding.artifactSha256,
      contentSha256: censusBinding.contentSha256, coverageSha256: censusBinding.coverageSha256,
      completedAt: census.census.bookendCompletedAt ?? census.census.completedAt };
    const rows: { sourceFingerprint: string; issueNumber: number | null; outcome: "verified" | "refused";
      reason?: string; detail?: string; classification?: LegacyClassification | { requested: LegacyClassification["requested"]; observed: null; matches: null; drift: null };
      proof?: unknown }[] = [];
    for (const sourceFingerprint of selected) {
      const identity = identityFor(sourceFingerprint);
      let issueNumber: number | null = null;
      const refuse = (reason: string, detail: string) => rows.push({ sourceFingerprint, issueNumber, outcome: "refused", reason, detail });
      try {
        claim?.withOwnership(() => {});
        const current = claim === undefined ? journal : claim.withOwnership(() => readJournal(journalPath));
        const state = resolveDurableState(indexHistory(current.records, current.tail), identity);
        if ("operation" in state) issueNumber = state.operation.result.issueNumber;
        if (state.kind !== "legacy_unverified") { refuse("state_drift", `Current state ${state.kind}; expected legacy_unverified.`); continue; }
        const anchor = state.operation.history.at(-1)!;
        const envelope = object(anchor.value);
        const raw = originalRow(anchor.value);
        const requested = parseLegacyRequested(raw?.operatorFinalClassification);
        if (requested === null || raw === null || envelope?.kind !== "legacy_import" || typeof envelope.importedFrom !== "string"
          || envelope.importedFrom.trim() === "" || state.operation.action !== "create_issue") {
          refuse("legacy_metadata_invalid", "Imported create row requires a valid non-empty Type/Priority/Effort request set."); continue;
        }
        if (issueNumber === null || state.operation.result.issueId === null || state.operation.result.commentId !== null) {
          refuse("retained_identity_mismatch", "Legacy create must retain an issue number and ID, with no comment identity."); continue;
        }
        const proof = proveCreateOwnership({ ...identity, firstAttemptAt: typeof raw.appliedAt === "string" ? raw.appliedAt : "",
          retained: state.operation.result, census, censusBinding });
        if (proof.kind === "refusal") { refuse(proof.reason, proof.detail); continue; }
        if (claim === undefined) {
          rows.push({ sourceFingerprint, issueNumber, outcome: "verified", proof,
            detail: "Census proof only; live identity and classification have not been read.",
            classification: { requested, observed: null, matches: null, drift: null } });
          continue;
        }
        let liveIssue: OwnershipLiveIssue | undefined;
        const confirmation = await confirmOwnershipLive(proof, { fetchIssue: (repository, number) =>
          claim.withOwnership(async () => { liveIssue = await transport!.fetchIssue(repository, number); return liveIssue; }) });
        claim.withOwnership(() => {});
        if (confirmation.kind === "refusal") { refuse(confirmation.reason, confirmation.detail); continue; }
        const observed = await claim.withOwnership(() => transport!.readClassifications!(args.repository, proof.issueNumber, liveIssue!));
        const classification = compareLegacyClassification(requested, observed);
        const now = input.now ?? new Date();
        const event: LegacyVerifiedExecutionEvent = {
          schemaVersion: INTAKE_APPROVAL_LEDGER_SCHEMA, event: "legacy_verified", appliedAt: now.toISOString(), ...identity,
          // Keep the original ID representation (node ID or database ID), now confirmed live.
          result: state.operation.result,
          legacyVerification: { legacyRowDigest: canonicalJsonSha256(raw), importedFrom: basename(envelope.importedFrom),
            priorEventRowNumber: anchor.rowNumber, runId: args.runId, census: censusEvidence, censusMarker: proof.censusMarker,
            liveMarker: confirmation.live.liveMarker, live: { bodySha256: confirmation.live.bodySha256,
              createdAt: confirmation.live.createdAt, fetchedAt: confirmation.live.fetchedAt, requestId: confirmation.live.requestId ?? null },
            classification, operator: userInfo().username, at: now.toISOString() },
        };
        // A claim fences cooperative writers; detect hand edits while the reads were in flight too.
        const latest = claim.withOwnership(() => readJournal(journalPath));
        const latestState = resolveDurableState(indexHistory(latest.records, latest.tail), identity);
        if (latestState.kind !== "legacy_unverified" || latestState.operation.history.at(-1)!.rowNumber !== anchor.rowNumber
          || canonicalJsonSha256(latestState.operation.history.at(-1)!.value) !== canonicalJsonSha256(anchor.value)) {
          refuse("state_drift", "Legacy history changed during verification."); continue;
        }
        const proposed = resolveDurableState(indexHistory([...latest.records, event], latest.tail), identity);
        if (proposed.kind !== "complete") { refuse("legacy_verification_invariant", `Proposed legacy_verified resolves to ${proposed.kind}.`); continue; }
        claim.withOwnership(() => appendJournal(journalPath, event));
        rows.push({ sourceFingerprint, issueNumber, outcome: "verified", classification });
      } catch (cause) {
        if (cause instanceof JournalWriteError || cause instanceof ExecutionOwnershipError) throw cause;
        refuse("verification_failed", cause instanceof Error ? cause.message : String(cause));
      }
    }
    const summary = { verified: rows.filter((row) => row.outcome === "verified").length,
      refused: rows.filter((row) => row.outcome === "refused").length,
      classificationDrift: rows.filter((row) => row.classification?.matches === false).length };
    (input.log ?? console.log)(JSON.stringify({ repository: args.repository, journalPath, census: censusEvidence, execute: args.execute, rows, summary }, null, 2));
    return summary.refused === 0 ? 0 : 1;
  } catch (cause) { failed = true; throw cause; }
  finally {
    try { claim?.release(); }
    catch (cause) { if (!failed) throw cause; }
  }
}

export function runIntakeResolveCli(input: ResolveCliInput): number | Promise<number> {
  const log = input.log ?? console.log;
  const error = input.error ?? console.error;
  try {
    const args = parseArguments(input.argv);
    if (args.command === "verify-legacy") return verifyLegacy(args, input).catch((cause) => {
      error(cause instanceof Error ? cause.message : String(cause)); return 1;
    });
    if (args.command === "reconcile") return reconcile(args, input).catch((cause) => {
      error(cause instanceof Error ? cause.message : String(cause)); return 1;
    });
    const journalPath = resolveJournalPath(args.repository);
    const now = input.now ?? new Date();
    if (args.command === "status") {
      log(JSON.stringify(status(args.repository, journalPath, now, args.sourceFingerprint === undefined ? undefined : args), null, 2));
      return 0;
    }
    // Acquire before the first read. Preview deliberately holds no claim and makes no writes.
    const claim = args.execute ? acquireExecutionClaim(journalPath, { mode: "resolve" }) : undefined;
    try {
      const journal = readJournal(journalPath);
      const state = resolveOperatorState(indexHistory(journal.records, journal.tail), args);
      const event = abandonmentEvent(state, args.reason, now);
      if (state.kind !== args.expectedState) {
        throw new Error(`Abandon refused: current state ${state.kind}; expected state ${args.expectedState}.`);
      }
      if (claim !== undefined) {
        const currentJournal = readJournal(journalPath);
        const currentState = resolveOperatorState(indexHistory(currentJournal.records, currentJournal.tail), args);
        const currentEvent = abandonmentEvent(currentState, args.reason, now);
        if (currentState.kind !== args.expectedState) {
          throw new Error(`Abandon refused: current state ${currentState.kind}; expected state ${args.expectedState}.`);
        }
        if (event.abandonment.priorEventRowNumber !== currentEvent.abandonment.priorEventRowNumber) {
          throw new Error(`Abandon refused: priorEventRowNumber ${event.abandonment.priorEventRowNumber}; latest event row ${currentEvent.abandonment.priorEventRowNumber}.`);
        }
        claim.withOwnership(() => appendJournal(journalPath, event));
      }
      log(JSON.stringify({ repository: args.repository, journalPath, execute: args.execute, event }, null, 2));
    } finally { claim?.release(); }
    return 0;
  } catch (cause) {
    if (cause instanceof UsageError) { error(USAGE + (cause.message === "" ? "" : `\n${cause.message}`)); return 2; }
    error(cause instanceof Error ? cause.message : String(cause));
    return 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  void Promise.resolve(runIntakeResolveCli({ argv: process.argv.slice(2) })).then((code) => { process.exitCode = code; });
}
