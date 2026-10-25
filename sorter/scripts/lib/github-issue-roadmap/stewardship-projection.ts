import { canonicalJsonSha256 } from "./canonical-json";
import { AUTHORED_START_COMMANDS } from "./start-command-values";
import { classifyStewardshipAssessmentAgreement, STEWARDSHIP_ASTRA_ASSESSMENT_PROTOCOL, stewardshipAssessmentEnvelopeSchema, type StewardshipAssessmentEnvelope, type StewardshipMergedRanking } from "./stewardship-assessment";
import { stewardshipPacketRubricCurrency, type StewardshipIssueEvidencePacket, type StewardshipSourceExcerpt } from "./stewardship-evidence";
import type { StewardshipEvent, StewardshipLifecycleReceipt, StewardshipState } from "./stewardship-state";
import { knownStewardshipPolicy, resolveStewardshipPolicy, stewardshipOperationValue, stewardshipPolicyUpgradePreservesAssessments } from "./stewardship-policy";
import type { StewardshipObservation } from "./stewardship-github";
import type { StewardshipStartCommandFacts } from "./stewardship-start-command";

interface JournalEntry { readonly at: string; readonly event: StewardshipEvent }
type Packet = StewardshipIssueEvidencePacket;
interface Pair { packet: Packet; packetSha256: string; at: string; envelopes: [StewardshipAssessmentEnvelope, StewardshipAssessmentEnvelope]; legacy?: boolean }
interface Pin { value: string | null; at: string; source: "explicit" | "operator" }
interface CoverageOutcome {
  outcome: "glm_refused"; reason: "local_path"; seat: "codex";
  packetSha256: string; assessmentSha256: string; currencyKey: string; assessedAt: string;
}
interface CurrentAssessment {
  packetSha256: string;
  assessments: readonly [StewardshipAssessmentEnvelope, StewardshipAssessmentEnvelope];
  currencyKey: string; phase: Packet["evidencePhase"]; assessedAt: string; ranking: StewardshipMergedRanking;
  seats: { family: StewardshipAssessmentEnvelope["seat"]["family"]; doneStale: StewardshipMergedRanking["doneStale"]["seats"][number]; codeNeeded: readonly string[]; severity: Extract<StewardshipAssessmentEnvelope, { schemaVersion: "github-issue-roadmap-stewardship-assessment/v2" }>["assessment"]["ranking"]["severity"] }[];
  phaseBVerified: boolean; excerptCapturedAt: string | null;
}
/** Archived v1 projections omit the format marker and live Start facts. */
interface StewardshipProjection {
  compileFormat?: "github-issue-roadmap-backlog-compile/v2";
  issues: Record<number, { status: "current" | "stale" | "unassessed" | "closed"; assessment: CurrentAssessment | null; coverageOutcome?: CoverageOutcome;
    pins: ReturnType<typeof pins>; blockers: ReturnType<typeof blockers>;
    startCommandFacts?: Omit<StewardshipStartCommandFacts, "assessment"> } & Omit<ReturnType<typeof compileFacts>, "startCommandFacts">>;
  coverage: { total: number; covered: number; needsEvidence: number; unranked: number[];
    settledWithoutGlm?: ({ issueNumber: number } & CoverageOutcome)[];
    lifecycleReceiptsAvailable?: true; refusal: string | null; complete: boolean };
}
/** The coverage rule is shared with the journal-only admission check. */
export function stewardshipProjectionCovered(closed: boolean, pin: { Horizon: unknown; Effort: unknown }, assessment: unknown, outcome?: CoverageOutcome): boolean {
  return Boolean(closed || pin.Horizon || pin.Effort || assessment || outcome?.outcome === "glm_refused");
}
const specPath = "docs/roadmap/milestone-1.md";
function artifact(read: (hash: string) => unknown, hash: string): unknown {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid projection artifact hash");
  const value = read(hash);
  if (canonicalJsonSha256(value) !== hash) throw new Error("Projection artifact hash mismatch");
  return value;
}
function hasAssessments(assessments: unknown): boolean {
  return Array.isArray(assessments) && assessments.length > 0;
}
/**
 * Derived currency only: old artifacts and journal entries remain immutable, including GLM's.
 * An absent protocol is the legacy (shared-thread) codex identity: never a refusal, only not current.
 */
function stewardshipAssessmentProtocolCurrent(envelope: StewardshipAssessmentEnvelope): boolean {
  return envelope.seat.family !== "codex" || envelope.seat.assessmentProtocol === STEWARDSHIP_ASTRA_ASSESSMENT_PROTOCOL;
}
function decisionAssessments(decisionSha256: string, read: (hash: string) => unknown) {
  let hashes: string[];
  try {
    const decision = artifact(read, decisionSha256) as { assessmentSha256s?: unknown } | null;
    if (!Array.isArray(decision?.assessmentSha256s) || !decision.assessmentSha256s.every((hash) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))) {
      throw new Error("Invalid decision assessment hashes");
    }
    hashes = decision.assessmentSha256s;
  } catch { return { assessments: [], reason: "invalid_decision_artifact" as const }; }
  return { assessments: hashes.map((hash) => {
    try { return { sha256: hash, envelope: stewardshipAssessmentEnvelopeSchema.parse(artifact(read, hash)) }; }
    catch { return { sha256: hash, envelope: null }; }
  }), reason: null };
}
export function stewardshipDecisionAssessmentProtocolsCurrent(decisionSha256: string, read: (hash: string) => unknown): boolean {
  const { assessments, reason } = decisionAssessments(decisionSha256, read);
  return reason === null && assessments.length === 2 && assessments.every(({ envelope }) => envelope !== null && stewardshipAssessmentProtocolCurrent(envelope));
}
/** Read-only receipt usable directly with the live journal and content-addressed artifact reader. */
export function stewardshipAssessmentProtocolReceipt(journal: readonly JournalEntry[], read: (hash: string) => unknown) {
  const invalidated = new Map<string, { issueNumber: number; assessmentSha256: string | null; assessedAt: string;
    decisionSha256?: string; reason: "assessment_protocol_not_current" | "invalid_assessment_artifact" | "invalid_decision_artifact" }>();
  const seatUnavailableWithoutAssessment: { runId: string; issueNumber: number; at: string }[] = [];
  for (const { event, at } of journal) {
    if (event.type === "issue-assessed") {
      const { assessments, reason } = decisionAssessments(event.decisionSha256, read);
      if (reason || assessments.length !== 2) invalidated.set(`decision:${event.issueNumber}:${event.decisionSha256}`, {
        issueNumber: event.issueNumber, assessmentSha256: null, decisionSha256: event.decisionSha256, assessedAt: at, reason: "invalid_decision_artifact",
      });
      for (const { sha256, envelope } of assessments) {
        if (envelope === null || !stewardshipAssessmentProtocolCurrent(envelope)) invalidated.set(envelope === null ? `${event.issueNumber}:${sha256}` : sha256, {
          issueNumber: envelope?.assessment.binding.issueNumber ?? event.issueNumber, assessmentSha256: sha256, assessedAt: envelope?.assessedAt ?? at,
          reason: envelope === null ? "invalid_assessment_artifact" : "assessment_protocol_not_current",
        });
      }
    }
    if (event.type === "run-finished") {
      let report: { deferred?: { issueNumber: number; reason: string; assessments?: unknown[] }[] } | null;
      // The receipt is diagnostic output; an unreadable report must not stop the run that renders it.
      try { report = artifact(read, event.resultSha256) as typeof report; } catch { continue; }
      for (const entry of (Array.isArray(report?.deferred) ? report.deferred : [])) {
        // A hash-valid report can still hold malformed entries; skip them rather than throw.
        if (entry === null || typeof entry !== "object" || !Number.isSafeInteger(entry.issueNumber)) continue;
        if (entry.reason === "seat_unavailable" && !hasAssessments(entry.assessments)) {
          seatUnavailableWithoutAssessment.push({ runId: event.runId, issueNumber: entry.issueNumber, at });
        }
      }
    }
  }
  const invalidatedAssessments = [...invalidated.values()].sort((a, b) => a.issueNumber - b.issueNumber || a.assessedAt.localeCompare(b.assessedAt));
  return { invalidatedIssueNumbers: [...new Set(invalidatedAssessments.map((entry) => entry.issueNumber))], invalidatedAssessments,
    seatUnavailableWithoutAssessment: seatUnavailableWithoutAssessment.sort((a, b) => a.issueNumber - b.issueNumber || a.at.localeCompare(b.at)) };
}
function pairs(journal: readonly JournalEntry[], read: (hash: string) => unknown): Pair[] {
  const result: Pair[] = [];
  for (const { event, at } of journal) {
    if (event.type === "policy-upgraded") {
      if (!stewardshipPolicyUpgradePreservesAssessments(artifact(read, event.previousPolicySha256), artifact(read, event.policySha256))) {
        for (const pair of result) pair.legacy = true;
      }
      continue;
    }
    if (event.type === "issue-attempted" && qualifiedLocalPathAttempt(event, journal, read)) {
      // A refusal supersedes earlier pairs; removing the path cannot resurrect an old ranking.
      for (const pair of result) if (pair.packet.issueNumber === event.issueNumber) pair.legacy = true;
    }
    if (event.type !== "issue-assessed") continue;
    const { assessments, reason } = decisionAssessments(event.decisionSha256, read);
    if (reason || assessments.length !== 2 || assessments.some(({ envelope }) => envelope === null)) continue;
    const envelopes = assessments.map(({ envelope }) => envelope!) as Pair["envelopes"];
    const [left, right] = envelopes;
    const binding = left.assessment.binding;
    if (left.seat.family === right.seat.family || canonicalJsonSha256(binding) !== canonicalJsonSha256(right.assessment.binding)
      || binding.issueNumber !== event.issueNumber || binding.materialEvidenceSha256 !== event.materialEvidenceSha256) continue;
    const packet = artifact(read, binding.packetSha256) as Packet;
    if (packet.issueNumber !== event.issueNumber || packet.materialEvidenceSha256 !== event.materialEvidenceSha256) continue;
    // An envelope must refer to evidence recorded in this journal, before this assessment.
    const recorded = journal.slice(0, journal.findIndex((entry) => entry.event === event)).some((entry) => entry.event.type === "evidence-recorded"
      && entry.event.issueNumber === event.issueNumber && entry.event.packetSha256 === binding.packetSha256);
    if (recorded) result.push({ packet, packetSha256: binding.packetSha256, at, envelopes });
  }
  return result;
}
function excerptContent(packet: Packet) {
  const excerpts = packet.sourceExcerpts ?? [];
  return excerpts.map((range) => {
    const source = packet.sources.find((source) => source.path === range.path && source.excerpt?.startLine === range.startLine && source.excerpt.endLine === range.endLine);
    return source ? { path: range.path, startLine: range.startLine, endLine: range.endLine, contentSha256: source.snippetSha256 } : null;
  }).sort((a, b) => canonicalJsonSha256(a).localeCompare(canonicalJsonSha256(b)));
}
/** KTD15 content identity, independent of writable fields and the enclosing main commit. */
export function stewardshipAssessmentCurrencyKey(packet: Packet): string | null {
  const relationships = packet.issue.relationships;
  const sort = <T>(values: readonly T[]) => [...values].sort((a, b) => canonicalJsonSha256(a).localeCompare(canonicalJsonSha256(b)));
  const excerpts = excerptContent(packet);
  if (excerpts.some((entry) => entry === null)) return null;
  return canonicalJsonSha256({ title: packet.title, body: packet.body, labels: sort(packet.issue.v1.labels), nativeType: packet.issue.nativeType,
    relationships: { parent: relationships.parent, subIssues: sort(relationships.subIssues), blockedBy: sort(relationships.blockedBy.map((link) => ({
      repository: link.repository.nodeId ?? link.repository.databaseId, number: link.number,
    }))), blocking: sort(relationships.blocking) },
    state: packet.issue.v1.state, latestReopenEventId: [...(packet.reopenEvents ?? [])]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).at(-1)?.id ?? null,
    rubricIdentity: packet.rubricIdentity ?? null,
    ...(packet.evidencePhase === "expanded" ? { excerpts } : {}) });
}
function currency(packet: Packet, currentSpec: string): string | null {
  return stewardshipPacketRubricCurrency(packet, currentSpec) === "current" ? stewardshipAssessmentCurrencyKey(packet) : null;
}
function qualifiedLocalPathAttempt(event: Extract<StewardshipEvent, { type: "issue-attempted" }>,
  journal: readonly JournalEntry[], read: (hash: string) => unknown) {
  const attempt = event.assessmentAttempt;
  if (!attempt || attempt.assessmentSha256s.length !== 1) return;
  const glmDiagnostics = attempt.diagnostics.filter((diagnostic) => diagnostic.seat === "glm");
  if (glmDiagnostics.length !== 1) return;
  const diagnostic = glmDiagnostics[0];
  if (diagnostic.seat !== "glm" || diagnostic.stage !== "input" || diagnostic.code !== "local_path" || diagnostic.field !== "$") return;
  try {
    const envelope = stewardshipAssessmentEnvelopeSchema.parse(artifact(read, attempt.assessmentSha256s[0]));
    const packet = artifact(read, attempt.packetSha256) as Packet;
    const binding = envelope.assessment.binding;
    if (envelope.seat.family !== "codex" || !stewardshipAssessmentProtocolCurrent(envelope) || !("ranking" in envelope.assessment)
      || binding.issueNumber !== event.issueNumber || packet.issueNumber !== event.issueNumber
      || binding.packetSha256 !== attempt.packetSha256 || binding.materialEvidenceSha256 !== packet.materialEvidenceSha256) return;
    const recorded = journal.slice(0, journal.findIndex((entry) => entry.event === event)).some(({ event: prior }) => prior.type === "evidence-recorded"
      && prior.issueNumber === event.issueNumber && prior.packetSha256 === attempt.packetSha256);
    return recorded ? { packet, packetSha256: attempt.packetSha256, assessmentSha256: attempt.assessmentSha256s[0], envelope } : undefined;
  } catch { return; }
}
// These reasons are necessary but not sufficient: the run's hash-verified report must prove the deferred issue had no seat answer
// (sort.ts:1083-1087). Unknown or new reasons keep displacing (fail closed).
const LOCAL_PATH_NON_DISPLACING_ATTEMPT_REASONS = new Set(["seat_unavailable"]);
/**
 * Latest attempt only, except receipt-free listed reasons whose run's hash-verified report proves no seat answered
 * for the deferred issue (sort.ts:1083-1087). Other attempts and assessment-invalidating upgrades revoke the exception.
 */
function localPathAttempts(journal: readonly JournalEntry[], read: (hash: string) => unknown) {
  type DeferredEntry = { issueNumber: number; reason: string; assessments?: unknown };
  const deferredByRun = new Map<string, DeferredEntry[]>();
  // Reports follow attempts in the journal, so verify and index them before deciding which attempts displace.
  for (const { event } of journal) {
    if (event.type !== "run-finished") continue;
    try {
      const report = artifact(read, event.resultSha256) as { deferred?: DeferredEntry[] } | null;
      deferredByRun.set(event.runId, Array.isArray(report?.deferred) ? report.deferred : []);
    } catch { deferredByRun.delete(event.runId); }
  }
  const latest = new Map<number, Extract<StewardshipEvent, { type: "issue-attempted" }>>();
  for (const { event } of journal) {
    if (event.type === "policy-upgraded"
      && !stewardshipPolicyUpgradePreservesAssessments(artifact(read, event.previousPolicySha256), artifact(read, event.policySha256))) latest.clear();
    if (event.type === "issue-assessed") latest.delete(event.issueNumber);
    if (event.type === "issue-attempted") {
      if (!event.assessmentAttempt && LOCAL_PATH_NON_DISPLACING_ATTEMPT_REASONS.has(event.reason)) {
        const deferred = (deferredByRun.get(event.runId) ?? []).filter((entry) => entry !== null && typeof entry === "object"
          && entry.issueNumber === event.issueNumber);
        // A keyless {issueNumber, reason} entry is a never-admitted deferRemaining packet
        // (sort.ts:1083-1087, called at sort.ts:1280); it preserves coverage.
        // assessments: [] is a result-path entry (sort.ts:1215) that can follow earlier-phase
        // answers (stewardship-assessment.ts:671); it displaces coverage.
        // A nonempty assessments array means a seat answered; it displaces coverage.
        if (deferred.some((entry) => entry.reason === "seat_unavailable") && deferred.every((entry) =>
          !Object.hasOwn(entry, "assessments"))) continue;
      }
      latest.set(event.issueNumber, event);
    }
  }
  return [...latest.values()].flatMap((event) => {
    const attempt = qualifiedLocalPathAttempt(event, journal, read);
    return attempt ? [attempt] : [];
  });
}
function localPathCurrency(packet: Packet, spec: string) {
  const key = currency(packet, spec);
  // Initial evidence can contain source text too; all source bytes bind this exception.
  return key === null ? null : canonicalJsonSha256({ key, sources: packet.sources.map(({ path, snippetSha256 }) => ({ path, snippetSha256 })) });
}
function localPathOutcome(attempt: ReturnType<typeof localPathAttempts>[number] | undefined, packet: Packet | undefined,
  recaptured: Readonly<Record<string, Packet>> | undefined): CoverageOutcome | undefined {
  const spec = packet?.sources.find((source) => source.path === specPath)?.text;
  if (!attempt || !packet || !spec) return;
  const live = attempt.packet.evidencePhase === "expanded" ? recaptured?.[attempt.packetSha256] : packet;
  if (!live || live.issue.identity.nodeId !== packet.issue.identity.nodeId
    || currency({ ...live, evidencePhase: "initial" }, spec) !== currency({ ...packet, evidencePhase: "initial" }, spec)) return;
  const key = localPathCurrency(attempt.packet, spec);
  if (key === null || key !== localPathCurrency(live, spec)) return;
  return { outcome: "glm_refused", reason: "local_path", seat: "codex", packetSha256: attempt.packetSha256,
    assessmentSha256: attempt.assessmentSha256, currencyKey: key, assessedAt: attempt.envelope.assessedAt };
}
/** Only accepted ranges are re-read. Old blob IDs must not veto a read from CURRENT main. */
export function stewardshipProjectionRecaptures(journal: readonly JournalEntry[], readArtifact: (hash: string) => unknown): { packetSha256: string; issueNumber: number; excerpts: StewardshipSourceExcerpt[] }[] {
  return [...new Map([...pairs(journal, readArtifact).filter((pair) => !pair.legacy && pair.envelopes.every(stewardshipAssessmentProtocolCurrent)),
    ...localPathAttempts(journal, readArtifact)].filter((pair) =>
    pair.packet.evidencePhase === "expanded").map((pair) => [pair.packetSha256,
    { packetSha256: pair.packetSha256, issueNumber: pair.packet.issueNumber, excerpts: (pair.packet.sourceExcerpts ?? []).map(({ path, startLine, endLine }) => ({ path, startLine, endLine })) }])).values()];
}
function pins(input: { journal: readonly JournalEntry[]; state?: StewardshipState; initializedAt: string; operator: string }, packet: Packet | undefined, issueNumber: number) {
  const result: { Horizon: Pin | null; Effort: Pin | null } = { Horizon: null, Effort: null };
  // Plan R7: any operator change after adoption pins, even before the sorter first observed the issue.
  // Filing's own stamp is excluded below by the creator window, not by delaying the operator window.
  const observedAfter = Date.parse(input.state?.snapshotAdoptedAt ?? input.initializedAt);
  const writesField = (operation: { kind: string }, field: string) => operation.kind.match(/^(?:set|clear)_(.+)$/)?.[1] === field.toLowerCase();
  for (const field of ["Horizon", "Effort"] as const) {
    const state = input.state?.issues[issueNumber]?.fields[field];
    const history = packet?.fieldHistory[field];
    if (state?.hold && (state.hold.kind === "pin" || (state.hold.kind === "operator" && !history?.frontier.complete)) && (state.hold.kind === "pin" || Date.parse(state.hold.at) > observedAfter)) {
      result[field] = { value: state.hold.value as string | null, at: state.hold.at, source: state.hold.kind === "pin" ? "explicit" : "operator" };
    }
    let releasedAt = state?.releasedAt ?? input.initializedAt;
    let pinnedValue = input.state?.issues[issueNumber]?.baseline.fields[field];
    let frontierIds = input.state?.issues[issueNumber]?.baseline.frontiers[field]?.eventIds ?? [];
    const supersededIds = new Set<string>();
    for (const { event } of input.journal) {
      if (event.type === "initialized") {
        const baseline = event.initialization.census.issues.find((issue) => issue.issueNumber === issueNumber);
        if (baseline) { pinnedValue = baseline.fields[field]; frontierIds = baseline.frontiers[field]?.eventIds ?? []; }
      }
      if (event.type === "issue-baselined" && event.baseline.issueNumber === issueNumber) {
        pinnedValue = event.baseline.fields[field]; frontierIds = event.baseline.frontiers[field]?.eventIds ?? [];
      }
    }
    for (const { event, at } of input.journal) {
      if (!("issueNumber" in event) || event.issueNumber !== issueNumber || !("field" in event) || event.field !== field) continue;
      if (event.type === "field-observed" || event.type === "field-history-recovered" || event.type === "field-released") {
        pinnedValue = event.value as string | null; frontierIds = event.frontier.eventIds;
      }
      if (event.type === "field-pinned") result[field] = { value: (pinnedValue !== undefined ? pinnedValue : state?.hold?.kind === "pin" ? state.hold.value : packet?.fields[field] ?? state?.value ?? null) as string | null, at, source: "explicit" };
      if (event.type === "field-released") { result[field] = null; releasedAt = at; }
      if (event.type === "hold-superseded") {
        for (const id of frontierIds) supersededIds.add(id);
        if (result[field]?.source === "operator") result[field] = null;
      }
    }
    const actions = new Map<string, { operation: Extract<StewardshipEvent, { type: "action-attempted" }>["operation"];
      at: string; policySha256: string; snapshotSha256?: string; outcome: StewardshipState["actions"][string]["outcome"]; nativeEventIds: readonly string[] }>();
    for (const [id, action] of Object.entries(input.state?.actions ?? {})) if (action.issueNumber === issueNumber && writesField(action.operation, field)) {
      actions.set(id, { ...action, at: action.attemptedAt, policySha256: action.policySha256 ?? input.state!.policySha256 });
    }
    for (const { event, at } of input.journal) {
      if (event.type === "action-attempted" && event.issueNumber === issueNumber && writesField(event.operation, field) && !actions.has(event.actionId)) {
        actions.set(event.actionId, { ...event, at, outcome: null, nativeEventIds: [] });
      }
      if (event.type === "action-outcome" && !input.state?.actions[event.actionId]) {
        const action = actions.get(event.actionId);
        if (action) { action.outcome = event.outcome; action.nativeEventIds = event.nativeEventIds ?? []; }
      }
    }
    const receipts = new Set([...actions.values()].filter((action) => action.outcome === "confirmed").flatMap((action) => action.nativeEventIds));
    const attempts = [...actions.values()].filter((action) => action.snapshotSha256 && (action.outcome === null || action.outcome === "unresolved"))
      .map((action) => ({ ...action, executionBindingMs: resolveStewardshipPolicy(action.policySha256, knownStewardshipPolicy("v3", {
        repository: input.state?.repository ?? `${packet!.issue.identity.repository.organization}/${packet!.issue.identity.repository.name}`, operator: input.operator,
      })).limits.executionBindingMs }));
    if (history?.frontier.complete && result[field]?.source !== "explicit") {
      const edits = history.events.filter((event) => {
        const createdAt = Date.parse(event.createdAt);
        const sinceCreation = createdAt - Date.parse(packet!.issue.v1.createdAt);
        // Wider than the amendment's 60 s Priority-clear window on purpose: a pin errs toward a false non-pin,
        // while a clear errs toward keeping the value; a later "changed" edit by the creator still pins.
        const filingStamp = event.kind === "added" && packet?.authorLogin != null && event.actorLogin === packet.authorLogin
          && sinceCreation >= 0 && sinceCreation <= 120_000;
        const pendingSorterOutput = attempts.some((attempt) => createdAt >= Math.floor(Date.parse(attempt.at) / 1000) * 1000
          && createdAt <= Date.parse(attempt.at) + attempt.executionBindingMs
          && canonicalJsonSha256(event.values) === canonicalJsonSha256(stewardshipOperationValue(attempt.operation) === null ? [] : [stewardshipOperationValue(attempt.operation)]));
        return createdAt > Math.max(observedAfter, Date.parse(releasedAt)) && event.actorLogin === input.operator
          && !filingStamp && !pendingSorterOutput && !receipts.has(event.id) && !supersededIds.has(event.id);
      });
      const edit = edits.at(-1);
      if (edit) result[field] = { value: edit.values[0] ?? null, at: edit.createdAt, source: "operator" };
    }
  }
  return result;
}

/** Approval re-derives only the authority-bearing gates from journal-bound artifacts. */
export function validateStewardshipProjectionGates(input: { projection: ReturnType<typeof buildStewardshipProjection>;
  observations?: Record<number, StewardshipObservation>; state: StewardshipState; journal: readonly JournalEntry[]; readArtifact: (hash: string) => unknown; operator: string }) {
  let covered = 0; let substantive = false;
  const singleSeats = localPathAttempts(input.journal, input.readArtifact);
  if (input.state.shadowPass && canonicalJsonSha256(Object.keys(input.projection.issues).map(Number).sort((a, b) => a - b))
    !== canonicalJsonSha256([...input.state.shadowPass.issueNumbers].sort((a, b) => a - b))) throw new Error("Snapshot frozen census mismatch");
  for (const [number, issue] of Object.entries(input.projection.issues)) {
    if (issue.status === "closed" && input.state.shadowPass?.closedIssueNumbers.includes(Number(number))) { covered++; continue; }
    const observation = input.observations?.[Number(number)];
    if (!observation) throw new Error("Snapshot missing bound observation");
    const context = { journal: input.journal, state: input.state, initializedAt: input.state.initializedAt, operator: input.operator, readArtifact: input.readArtifact };
    const pin = pins(context, observation.evidence.packet, Number(number));
    if (canonicalJsonSha256(pin) !== canonicalJsonSha256(issue.pins)) throw new Error("Snapshot pins mismatch");
    const facts = compileFacts(context, observation.evidence.packet, Number(number));
    if (facts.effortWriter !== issue.effortWriter) throw new Error("Snapshot Effort writer mismatch");
    if (canonicalJsonSha256(facts.priorityProvenance) !== canonicalJsonSha256(issue.priorityProvenance)) throw new Error("Snapshot Priority provenance mismatch");
    if (facts.lifecycleReceiptAt !== issue.lifecycleReceiptAt || facts.lifecycleWithoutReceipt !== issue.lifecycleWithoutReceipt
      || facts.reopenHistoryComplete !== issue.reopenHistoryComplete || facts.lifecycleHistoryComplete !== issue.lifecycleHistoryComplete
      || canonicalJsonSha256(facts.reopens) !== canonicalJsonSha256(issue.reopens)) throw new Error("Snapshot Lifecycle provenance mismatch");
    const closed = observation.evidence.packet.issue.v1.state === "CLOSED";
    const outcome = closed ? undefined : localPathOutcome(singleSeats.find((entry) => entry.packet.issueNumber === Number(number)),
      observation.evidence.packet, { [issue.coverageOutcome?.packetSha256 ?? ""]: observation.evidence.packet });
    if (canonicalJsonSha256(outcome ?? null) !== canonicalJsonSha256(issue.coverageOutcome ?? null)) throw new Error("Snapshot coverage outcome mismatch");
    if (outcome && issue.assessment) throw new Error("Single-seat outcome cannot carry a decision assessment");
    if (stewardshipProjectionCovered(closed, pin, issue.assessment, outcome)) covered++;
    if (!issue.assessment) continue;
    if (!issue.assessment.assessments.every(stewardshipAssessmentProtocolCurrent)) throw new Error("Snapshot assessment protocol is not current");
    const stateIssue = input.state.issues[Number(number)];
    const assessments = [...(stateIssue?.assessmentHistory ?? []), ...(stateIssue?.assessment ? [stateIssue.assessment] : [])];
    const hashes = issue.assessment.assessments.map((envelope) => canonicalJsonSha256(envelope)).sort();
    if (hashes.length !== 2 || !assessments.some((assessed) => {
      const decision = decisionAssessments(assessed.decisionSha256, input.readArtifact);
      return decision.reason === null && decision.assessments.length === 2 && decision.assessments.every(({ envelope }) => envelope !== null)
        && canonicalJsonSha256(decision.assessments.map(({ sha256 }) => sha256).sort()) === canonicalJsonSha256(hashes);
    })) throw new Error("Snapshot assessment journal mismatch");
    const packet = artifact(input.readArtifact, issue.assessment.packetSha256) as Packet;
    const recorded = input.state.issues[Number(number)].evidencePackets?.[packet.materialEvidenceSha256];
    // A same-material recapture differing only in non-material bytes may be assessed; the first witness stays the index entry.
    const assessmentPacketRecorded = recorded?.packetSha256 === issue.assessment.packetSha256 || input.journal.some(({ event }) => event.type === "evidence-recorded"
      && event.issueNumber === Number(number) && event.packetSha256 === issue.assessment!.packetSha256
      && event.materialEvidenceSha256 === packet.materialEvidenceSha256);
    if (!recorded || !assessmentPacketRecorded || packet.issueNumber !== Number(number)
      || !issue.assessment.assessments.every((envelope) => envelope.assessment.binding.packetSha256 === issue.assessment!.packetSha256)) throw new Error("Snapshot assessment packet mismatch");
    const excerpts = excerptContent(packet);
    const verified = packet.evidencePhase === "expanded" && excerpts.length > 0 && excerpts.every((excerpt) => excerpt !== null);
    if (issue.assessment.phase !== packet.evidencePhase || issue.assessment.phaseBVerified !== verified
      || issue.assessment.excerptCapturedAt !== (packet.excerptCapturedAt ?? null)) throw new Error("Snapshot Phase B verification mismatch");
    if (!closed) substantive ||= issue.assessment.assessments.some(({ assessment }) => "ranking" in assessment
      && Object.values(assessment.ranking).some((field) => field.status === "assessed"));
  }
  const total = Object.keys(input.projection.issues).length;
  const refusal = total === 0 ? "empty_census" : !substantive && covered > 0 ? "all_abstain" : null;
  if (input.projection.coverage.refusal !== refusal) throw new Error("Snapshot coverage refusal mismatch");
  const complete = total > 0 && covered === total && substantive;
  if (input.projection.coverage.complete !== complete) throw new Error("Snapshot coverage completion mismatch");
}
function blockers(packet: Packet | undefined) {
  const gating: { qualified: string; nodeId: string; state: string | null }[] = [];
  const advisory: typeof gating = [];
  for (const link of packet?.issue.relationships.blockedBy ?? []) {
    const repo = packet!.issue.identity.repository;
    const local = link.repository.nodeId === repo.nodeId && link.repository.databaseId === repo.databaseId
      && `${link.repository.organization}/${link.repository.name}`.toLowerCase() === `${repo.organization}/${repo.name}`.toLowerCase();
    const value = { qualified: `${link.repository.organization}/${link.repository.name}#${link.number}`, nodeId: link.nodeId, state: link.state ?? null };
    (local && link.state === "OPEN" ? gating : advisory).push(value);
  }
  return { gating, advisory };
}

/** Current transport facts, kept separate from the assessment's historical evidence. */
function compileFacts(input: { journal: readonly JournalEntry[]; state?: StewardshipState; initializedAt: string; operator: string; readArtifact: (hash: string) => unknown }, packet: Packet | undefined, issueNumber: number) {
  const nativeLifecycle = packet?.issue.v1.fieldValues.flatMap((field) => {
    if (field === null || typeof field !== "object" || !("value" in field)) return [];
    const name = "name" in field ? field.name : "field" in field && field.field !== null && typeof field.field === "object" && "name" in field.field ? field.field.name : null;
    return name === "Lifecycle" && typeof field.value === "string" ? [field.value] : [];
  }) ?? [];
  const fields: { -readonly [K in Exclude<keyof Packet["fields"], "Sort key">]-?: NonNullable<Packet["fields"][K]> | null } & { "Sort key"?: number | null }
    = { Horizon: packet?.fields.Horizon ?? null, Effort: packet?.fields.Effort ?? null,
    ...(packet?.fields["Sort key"] === undefined ? {} : { "Sort key": packet.fields["Sort key"] }),
    Priority: packet?.fields.Priority ?? null,
    Lifecycle: packet?.fields.Lifecycle
      ?? (nativeLifecycle.length === 1 ? nativeLifecycle[0] : null) };
  const actions = new Map<string, { kind: string }>();
  const effortReceipts = new Set(Object.values(input.state?.actions ?? {}).filter((action) => action.issueNumber === issueNumber
    && action.outcome === "confirmed" && /^(?:set|clear)_effort$/.test(action.operation.kind)).flatMap((action) => action.nativeEventIds));
  // Native event time is the freshness anchor, never the later confirmation time.
  let lifecycleReceipt = input.state?.lifecycleReceipts?.[issueNumber] ?? null;
  let adoptionEffort = input.state?.issues[issueNumber]?.baseline.fields.Effort;
  for (const { event } of input.journal) {
    if (event.type === "initialized") adoptionEffort = event.initialization.census.issues.find((issue) => issue.issueNumber === issueNumber)?.fields.Effort;
    if (event.type === "action-attempted" && event.issueNumber === issueNumber) actions.set(event.actionId, event.operation);
    if (event.type !== "action-outcome" || event.outcome !== "confirmed") continue;
    const operation = actions.get(event.actionId);
    if (operation && /^(?:set|clear)_effort$/.test(operation.kind)) for (const id of event.nativeEventIds ?? []) effortReceipts.add(id);
    if (!input.state && operation && /^(?:set|clear)_lifecycle$/.test(operation.kind)) {
      const receipt = artifact(input.readArtifact, event.receiptSha256) as { lifecycle?: StewardshipLifecycleReceipt };
      if (!receipt.lifecycle || receipt.lifecycle.issueNumber !== issueNumber || !event.nativeEventIds?.includes(receipt.lifecycle.fieldEvent.id)) throw new Error("Invalid Lifecycle receipt");
      lifecycleReceipt = receipt.lifecycle;
    }
  }
  const history = packet?.fieldHistory.Effort;
  const latest = [...(history?.events ?? [])].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id)).at(-1);
  let effortWriter: "sorter" | "operator" | "filing" | "adoption" | "unknown" = "unknown";
  if (history?.frontier.complete) {
    const elapsed = latest && packet ? Date.parse(latest.createdAt) - Date.parse(packet.issue.v1.createdAt) : -1;
    if (latest && effortReceipts.has(latest.id)) effortWriter = "sorter";
    else if (latest?.kind === "added" && packet?.authorLogin != null && latest.actorLogin === packet.authorLogin && elapsed >= 0 && elapsed <= 120_000) effortWriter = "filing";
    else if (adoptionEffort !== undefined && adoptionEffort === fields.Effort && (!latest || Date.parse(latest.createdAt) <= Date.parse(input.initializedAt))) effortWriter = "adoption";
    else if (latest?.actorLogin === input.operator) effortWriter = "operator";
  }
  const body = packet?.body ?? "";
  const assessmentSection = body.split(/^## Assessment\s*\r?$/m)[1]?.split(/^## /m)[0];
  const classificationPattern = /^Intended classification: Type (Bug|Feature|Task|none) · Priority (P[0-3]|none) · Effort (Low|Medium|High|none)(?: · Start (\S+))?$/;
  const matches = (assessmentSection?.split(/\r?\n/) ?? []).flatMap((line) => {
    const match = classificationPattern.exec(line); return match ? [match] : [];
  });
  const match = matches.length === 1 ? matches[0] : null;
  const intendedClassification = match ? { type: match[1], priority: match[2], effort: match[3],
    ...((AUTHORED_START_COMMANDS as readonly string[]).includes(match[4]) ? { start: match[4] } : {}) } : null;
  const startCommandFacts: Omit<StewardshipStartCommandFacts, "assessment"> = {
    lifecycle: fields.Lifecycle as StewardshipStartCommandFacts["lifecycle"],
    pullRequests: (packet?.issue.pullRequests ?? []).map(({ state, relationship }) => ({ state, relationship })),
    type: packet?.issue.nativeType?.name ?? null, body, hasPlanWithUnits: (packet?.planEvidence ?? []).some((entry) => entry.hasImplementationUnits && entry.namesIssue),
    authoredStartCommand: AUTHORED_START_COMMANDS.find((value) => value === intendedClassification?.start) ?? null,
  };
  const lifecycleHistory = packet?.fieldHistory.Lifecycle;
  const latestLifecycle = lifecycleHistory?.events.at(-1);
  const lifecycleWithoutReceipt = fields.Lifecycle !== null && (!lifecycleReceipt || !lifecycleHistory?.frontier.complete
    || lifecycleReceipt.value !== fields.Lifecycle || latestLifecycle?.id !== lifecycleReceipt.fieldEvent.id
    || latestLifecycle.actorLogin !== lifecycleReceipt.fieldEvent.actor);
  return { fields, effortWriter, priorityProvenance: { body, authorLogin: packet?.authorLogin ?? null,
    createdAt: packet?.issue.v1.createdAt ?? null, history: structuredClone(packet?.fieldHistory.Priority.events ?? []),
    historyComplete: packet?.fieldHistory.Priority.frontier.complete ?? false,
    intendedClassification }, startCommandFacts,
    reopens: (packet?.reopenEvents ?? []).map(({ id, createdAt }) => ({ id, createdAt })),
    reopenHistoryComplete: packet?.reopenHistoryComplete === true,
    lifecycleHistoryComplete: lifecycleHistory?.frontier.complete === true,
    lifecycleReceiptAt: lifecycleReceipt?.fieldEvent.createdAt ?? null,
    ...(lifecycleWithoutReceipt ? { lifecycleWithoutReceipt: true as const } : {}) };
}
/** Pure journal/envelope projection. Callers supply current-main recaptures, never archived blobs as current evidence. */
export function buildStewardshipProjection(input: {
  census: readonly { issueNumber: number; state: string; fields?: Pick<Packet["fields"], "Sort key"> }[]; packets: readonly Packet[]; journal: readonly JournalEntry[];
  readArtifact: (hash: string) => unknown; recapturedPackets?: Readonly<Record<string, Packet>>;
  state?: StewardshipState; operator: string; initializedAt: string;
}): StewardshipProjection {
  const history = pairs(input.journal, input.readArtifact);
  const singleSeats = localPathAttempts(input.journal, input.readArtifact);
  const settledWithoutGlm: ({ issueNumber: number } & CoverageOutcome)[] = [];
  const issues: StewardshipProjection["issues"] = {};
  let covered = 0; let coveredWithoutSeats = 0; let needsEvidence = 0; let substantive = false;
  const unranked: number[] = [];
  for (const member of [...input.census].sort((a, b) => a.issueNumber - b.issueNumber)) {
    if (issues[member.issueNumber]) throw new Error("Duplicate projection census member");
    const packet = input.packets.find((packet) => packet.issueNumber === member.issueNumber);
    const candidates = history.filter((pair) => pair.packet.issueNumber === member.issueNumber);
    const pin = pins(input, packet, member.issueNumber);
    let assessment: CurrentAssessment | null = null;
    const spec = packet?.sources.find((source) => source.path === specPath)?.text;
    if (member.state === "OPEN" && packet && spec) for (const pair of [...candidates].reverse()) {
      if (pair.legacy || !pair.envelopes.every(stewardshipAssessmentProtocolCurrent)) continue;
      const live = pair.packet.evidencePhase === "expanded" ? input.recapturedPackets?.[pair.packetSha256] : { ...packet, evidencePhase: "initial" as const };
      if (!live || live.issue.identity.nodeId !== pair.packet.issue.identity.nodeId) continue;
      // Recapture must describe this census issue, not a different issue content generation.
      if (currency({ ...live, evidencePhase: "initial" }, spec) !== currency({ ...packet, evidencePhase: "initial" }, spec)) continue;
      const key = currency(pair.packet, spec);
      if (key === null || key !== currency(live, spec)) continue;
      const [left, right] = pair.envelopes;
      if (!("ranking" in left.assessment) || !("ranking" in right.assessment)) continue;
      const ranking = classifyStewardshipAssessmentAgreement(left.assessment, right.assessment).ranking;
      if (!ranking) continue;
      const seats = [left, right].map((envelope) => {
        const value = envelope.assessment;
        if (!("ranking" in value)) throw new Error("Expected ranking envelope");
        return { family: envelope.seat.family, doneStale: value.ranking.doneStale, codeNeeded: value.codeNeeded, severity: value.ranking.severity };
      });
      substantive ||= [left.assessment, right.assessment].some((value) => Object.values(value.ranking).some((field) => field.status === "assessed"));
      assessment = { packetSha256: pair.packetSha256, assessments: structuredClone(pair.envelopes), currencyKey: key, phase: pair.packet.evidencePhase, assessedAt: pair.at, ranking, seats,
        phaseBVerified: pair.packet.evidencePhase === "expanded" && excerptContent(pair.packet).length > 0,
        excerptCapturedAt: pair.packet.excerptCapturedAt ?? null };
      break;
    }
    const closed = member.state === "CLOSED";
    const coverageOutcome = closed ? undefined : localPathOutcome(singleSeats.find((entry) => entry.packet.issueNumber === member.issueNumber), packet, input.recapturedPackets);
    if (coverageOutcome) {
      assessment = null;
      settledWithoutGlm.push({ issueNumber: member.issueNumber, ...coverageOutcome });
    }
    const pinned = Boolean(pin.Horizon || pin.Effort);
    if (closed || pinned || coverageOutcome) coveredWithoutSeats++;
    if (stewardshipProjectionCovered(closed, pin, assessment, coverageOutcome)) covered++; else unranked.push(member.issueNumber);
    if (assessment && Object.values(assessment.ranking).some((field) => "status" in field && field.status === "needs_evidence")) needsEvidence++;
    const facts = compileFacts(input, packet, member.issueNumber);
    issues[member.issueNumber] = { status: closed ? "closed" : assessment ? "current" : candidates.length ? "stale" : "unassessed", assessment, pins: pin, blockers: blockers(packet),
      ...(coverageOutcome ? { coverageOutcome } : {}),
      ...facts,
      fields: { ...facts.fields,
        ...(member.fields && Object.hasOwn(member.fields, "Sort key") ? { "Sort key": member.fields["Sort key"] ?? null } : {}) } };
  }
  const refusal = input.census.length === 0 ? "empty_census" : !substantive && covered > 0 ? "all_abstain" : null;
  return { compileFormat: "github-issue-roadmap-backlog-compile/v2", issues, coverage: { total: input.census.length, covered: refusal ? coveredWithoutSeats : covered, needsEvidence, unranked,
    ...(settledWithoutGlm.length ? { settledWithoutGlm } : {}),
    ...(Object.keys(input.state?.lifecycleReceipts ?? {}).length > 0 ? { lifecycleReceiptsAvailable: true as const } : {}),
    refusal, complete: refusal === null && covered === input.census.length && input.census.length > 0 } };
}
