import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import { stewardshipOperationSchema, stewardshipWritableFields, type StewardshipPolicy } from "./stewardship-policy";
import type { buildStewardshipProjection } from "./stewardship-projection";
import type { StewardshipObservation } from "./stewardship-github";
import type { StewardshipObservationReuseRefusal } from "./stewardship-observation-reuse";
import { deriveStartCommand } from "./stewardship-start-command";
import { stewardshipRankKey, stewardshipScore } from "./stewardship-rank-key";
import { z } from "zod";

export const stewardshipFilingFieldReceiptsSchema = z.array(z.object({ issueNumber: z.number().int().positive().safe(),
  field: z.literal("Priority"), value: z.enum(["P0", "P1", "P2", "P3"]), eventId: z.string().min(1).optional(),
  eventCreatedAt: z.string().datetime({ offset: true }).optional(), writeStartedAt: z.string().datetime({ offset: true }).optional(),
  sourceFingerprint: z.string().min(1).optional(),
  readBackAt: z.string().datetime({ offset: true }) }).strict());

// Native Effort options from stewardship-policy.ts's set_effort operation.
const filingEffortValues = ["Low", "Medium", "High"] as const;
// Filing's parser refuses blank provenance; refuse it here too, without trimming what is kept.
const nonBlank = z.string().refine((value) => value.trim().length > 0);

/** Filing's public export; full provenance travels with archived compile inputs. */
// FilingFieldReceipt.field in filing-field-receipts.ts emits no Type receipts; Type is deliberately absent and the exporter contract test guards new fields.
export const stewardshipFilingFieldReceiptExportSchema = z.object({
  schemaVersion: z.literal("github-issue-roadmap-filing-field-receipts/v1"), repository: z.string().min(1),
  generatedAt: z.string().datetime({ offset: true }), records: z.array(z.discriminatedUnion("field", [z.object({
    issueNumber: z.number().int().positive().safe(), field: z.literal("Priority"), value: z.enum(["P0", "P1", "P2", "P3"]),
    eventId: nonBlank.optional(), eventCreatedAt: z.string().datetime({ offset: true }), writeStartedAt: z.string().datetime({ offset: true }),
    readBackAt: z.string().datetime({ offset: true }), sourceFingerprint: nonBlank,
  }).strict(), z.object({
    issueNumber: z.number().int().positive().safe(), field: z.literal("Effort"), value: z.enum(filingEffortValues),
    eventId: nonBlank, eventCreatedAt: z.string().datetime({ offset: true }), writeStartedAt: z.string().datetime({ offset: true }),
    readBackAt: z.string().datetime({ offset: true }), sourceFingerprint: nonBlank,
  }).strict()])),
}).strict();

type Projection = ReturnType<typeof buildStewardshipProjection>;
type Issue = Projection["issues"][number];
type Field = "Horizon" | "Effort" | "Priority" | "Lifecycle";
type Reason = "pinned" | "emergency" | "incumbent" | "tooling" | "blocker" | "formula" | "legacy_now_unranked";
interface PreviousIssue {
  issueNumber: number; horizon: string | null; reason: string; tier: string | null; severity: string | null;
  currencyKey: string | null; lifecycleReopenCurrencyKey: string | null;
  sortKey?: number | null;
  targets?: Target[];
}
export interface StewardshipObservationReuseRecord {
  reused: number; recaptured: number; deferred: number;
  refusalReasons: Partial<Record<StewardshipObservationReuseRefusal, number>>;
  reusedIssueNumbers: number[];
}
interface Input {
  observations?: Record<number, StewardshipObservation>;
  projection: Projection; previous: { issues: PreviousIssue[] } | null; policy: StewardshipPolicy;
  hasLiveSnapshot: boolean; firstApprovedCycleCompleted: boolean;
  coveredOnly?: boolean;
  /** Presence identifies the reuse-capable run assembly; older inputs omit it. */
  observationReuse?: StewardshipObservationReuseRecord;
  filingFieldReceipts?: readonly z.infer<typeof stewardshipFilingFieldReceiptsSchema>[number][];
  filingFieldReceiptsSha256?: string;
}
type Target = { disposition: "executable" | "report_only"; reason: string } & (
  { field: Field | "Start command"; current: string | null; value: string | null }
  | { field: "Sort key"; current: number | null; value: number | null }
);
interface StartCommandReport {
  counts: { byRow: Record<string, number>; holds: Record<string, number> };
  sample: { issueNumber: number; value: string | null; row: number | null }[];
  disagreeingPins: never[];
}
interface Candidate {
  number: number; issue: Issue; previous: PreviousIssue | undefined; incumbent: boolean; pinned: boolean;
  tier: string | null; severity: string | null; effort: Parameters<typeof stewardshipScore>[1]; lane: string | null;
  value: number | null; score: number | null; step: number; flagged: boolean; bothFlagged: boolean;
  emergency: boolean; ready: boolean; covered: boolean;
}
function merged<T>(field: { status: "merged"; value: T } | { status: "needs_evidence"; cause: string } | undefined): T | null {
  return field?.status === "merged" ? field.value : null;
}
const effortOrder = (effort: string | null) => effort === "low" ? 0 : effort === "medium" ? 1 : 2;
const tierOrder = (tier: string | null) => tier === "blocks_milestone" ? 0 : tier === "v1_not_blocking" ? 1 : tier === "not_v1" ? 2 : 3;
function tie(a: Candidate, b: Candidate) {
  return Number(b.incumbent) - Number(a.incumbent) || effortOrder(a.effort) - effortOrder(b.effort) || a.step - b.step || a.number - b.number;
}
function formula(a: Candidate, b: Candidate) { return (b.score ?? -1) - (a.score ?? -1) || tie(a, b); }
function productBlocker(a: Candidate, b: Candidate) {
  return effortOrder(a.effort) - effortOrder(b.effort) || (b.value ?? -1) - (a.value ?? -1) || tie(a, b);
}
function canonicalOrder(a: unknown, b: unknown): number {
  const left = canonicalJson(a); const right = canonicalJson(b);
  return left < right ? -1 : left > right ? 1 : 0;
}
function needsReopenClear(issue: Issue): boolean {
  return issue.status !== "closed" && issue.fields.Lifecycle !== null && issue.lifecycleReceiptAt !== null
    && issue.reopens.some((event) => Date.parse(event.createdAt) > Date.parse(issue.lifecycleReceiptAt!));
}
function needsHistoryClear(issue: Issue): boolean {
  return issue.status !== "closed" && issue.fields.Lifecycle !== null
    && (issue.reopenHistoryComplete !== true || issue.lifecycleHistoryComplete !== true);
}
/** Normalize input and order-free collections on a COPY for hashing. */
function snapshotCollections(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snapshotCollections).sort(canonicalOrder);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, snapshotCollections(child)]));
  return value;
}
function candidate(number: number, issue: Issue, previous: PreviousIssue | undefined): Candidate {
  const ranking = issue.assessment?.ranking;
  const tier = merged(ranking?.tier); const effort = merged(ranking?.effort); const value = merged(ranking?.value);
  const severity = merged(ranking?.severity); const lane = merged(ranking?.lane);
  const flags = ranking?.doneStale.seats ?? [];
  const flagged = flags.some((s) => s.status === "assessed" && s.value !== "no");
  const bothFlagged = flags.length === 2 && flags.every((s) => s.status === "assessed" && s.value !== "no");
  const pinned = Boolean(issue.pins.Horizon || issue.pins.Effort);
  const open = issue.status !== "closed";
  return { number, issue, previous, incumbent: previous?.horizon === "Now", pinned, tier, effort, value, severity, lane, flagged, bothFlagged,
    score: stewardshipScore(value, effort),
    step: merged(ranking?.milestoneStep) ?? Number.MAX_SAFE_INTEGER,
    emergency: open && severity === "P0" && issue.assessment?.phaseBVerified === true && issue.assessment.phase === "expanded" && !flagged,
    ready: open && issue.status === "current" && !flagged && issue.blockers.gating.length === 0 && tier !== null && lane !== null
      && (severity !== "P0" || (issue.assessment?.phaseBVerified === true && issue.assessment.phase === "expanded")),
    covered: issue.status === "closed" || pinned || issue.assessment !== null };
}
function exitReason(c: Candidate): string | null {
  if (!c.incumbent) return null;
  if (c.issue.status === "closed") return "closed";
  if (c.issue.pins.Horizon) return c.issue.pins.Horizon.value === "Now" ? null : "operator_move";
  if (!c.covered) return c.issue.fields.Horizon === "Now" ? null : "uncovered_keep_horizon";
  if (c.emergency) return null;
  if (c.issue.blockers.gating.length) return "native_blocker";
  if (c.bothFlagged) return "both_seats_done_stale";
  if (c.tier !== null && c.previous?.tier !== c.tier && (c.tier === "not_v1" || (c.previous?.tier === "blocks_milestone" && c.lane !== "tooling"))) return "tier_claim_removed";
  if (c.previous?.reason === "emergency" && c.severity !== null && c.severity !== "P0" && c.tier !== "blocks_milestone") return "severity_claim_removed";
  return null;
}
function newPriorityCohort(c: Candidate, receipts: Input["filingFieldReceipts"]): boolean {
  const { priorityProvenance: p, fields } = c.issue;
  if (!p.historyComplete || !p.authorLogin || !p.createdAt) return false;
  // Equality to the report's intended classification cannot identify filing's client.
  // A receipt must bind the FIRST event, and complete history must prove no later edit.
  if (p.history.length !== 1) return false;
  const event = p.history[0]; const elapsed = Date.parse(event.createdAt) - Date.parse(p.createdAt);
  return event.field === "Priority" && event.kind === "added" && event.actorLogin === p.authorLogin && elapsed >= 0 && elapsed <= 60_000
    && event.values.length === 1 && event.values[0] === fields.Priority && (receipts ?? []).some((receipt) => receipt.issueNumber === c.number
      && receipt.field === "Priority" && receipt.value === fields.Priority && receipt.eventId === event.id
      && receipt.eventCreatedAt !== undefined
      && Math.floor(Date.parse(receipt.eventCreatedAt) / 1000) === Math.floor(Date.parse(event.createdAt) / 1000));
}
function typedDemotion(c: Candidate): boolean {
  return c.issue.assessment?.assessments.every((envelope) => {
    const demotion = envelope.assessment.demotion;
    return demotion !== null && demotion.evidenceIds.length > 0
      && demotion.evidenceIds.every((id) => envelope.assessment.counterevidenceIds.includes(id));
  }) ?? false;
}

/** Pure U5 compile. Dispositions describe proposals, never grant write authority. */
export function compileStewardshipBacklog(input: Input) {
  if (input.filingFieldReceipts !== undefined) stewardshipFilingFieldReceiptsSchema.parse(input.filingFieldReceipts);
  const v2 = input.projection.compileFormat === "github-issue-roadmap-backlog-compile/v2";
  const writesSortKey = stewardshipWritableFields(input.policy).includes("Sort key");
  const startCommand: StartCommandReport | undefined = v2 ? { counts: { byRow: {}, holds: {} }, sample: [], disagreeingPins: [] } : undefined;
  const candidates = Object.entries(input.projection.issues).map(([number, issue]) => candidate(Number(number), issue,
    input.previous?.issues.find((previous) => previous.issueNumber === Number(number)))).sort((a, b) => a.number - b.number);
  const refusal = candidates.length === 0 ? "empty_census" : input.projection.coverage.refusal;
  const ordinaryStatus = refusal ? "refused" as const : !input.hasLiveSnapshot && !input.projection.coverage.complete ? "shadow_only" as const : "ready" as const;
  // Only an event-backed reopen can lift an otherwise held snapshot.
  const status = candidates.some((candidate) => needsReopenClear(candidate.issue)) ? "ready" as const : ordinaryStatus;
  const now = new Map<number, { candidate: Candidate; reason: Reason }>();
  const exits = new Map<number, string>();
  const waitingTooling: number[] = [];
  let addedEmergencies = 0;
  const add = (c: Candidate, reason: Reason) => now.set(c.number, { candidate: c, reason });
  for (const c of candidates) { const exit = exitReason(c); if (exit) exits.set(c.number, exit); }
  for (const c of candidates) if (c.issue.status !== "closed" && c.issue.pins.Horizon?.value === "Now") add(c, "pinned");
  for (const c of candidates) if (c.emergency && !c.issue.pins.Horizon && !now.has(c.number)) {
    add(c, "emergency"); if (!c.incumbent) addedEmergencies++;
  }
  for (const c of candidates) if (c.incumbent && !exits.has(c.number) && !now.has(c.number)) {
    const oldReason = c.previous!.reason;
    add(c, oldReason === "emergency" && !c.emergency ? c.tier === "blocks_milestone" ? "blocker" : "incumbent"
      : ["formula", "blocker", "tooling", "emergency"].includes(oldReason) ? oldReason as Reason : "incumbent");
  }
  const displaceable = () => [...now.values()].filter(({ candidate: c, reason }) => c.incumbent && !c.pinned && reason === "formula" && c.tier !== "blocks_milestone" && c.lane !== "tooling")
    .sort((a, b) => formula(b.candidate, a.candidate))[0]?.candidate;
  const displace = (reason: string) => {
    const lowest = displaceable(); if (!lowest) return false;
    now.delete(lowest.number); exits.set(lowest.number, reason); return true;
  };
  const emergencyDisplacements = Math.min(addedEmergencies, Math.max(0, now.size - 8));
  for (let n = 0; n < emergencyDisplacements && displace("displaced_by_emergency"); n++) { /* keep other overflow */ }
  while (now.size > 8 && displace("displaced_by_pin")) { /* protected overflow stays */ }
  const eligible = (c: Candidate) => c.ready && !c.issue.pins.Horizon && !now.has(c.number) && !exits.has(c.number);
  if (![...now.values()].some(({ candidate: c }) => c.lane === "tooling")) {
    const best = candidates.filter((c) => eligible(c) && c.lane === "tooling").sort((a, b) => tierOrder(a.tier) - tierOrder(b.tier) || formula(a, b))[0];
    if (best) {
      if (now.size < 8 || displace(`displaced_by_tooling:${best.number}`)) add(best, "tooling");
      else waitingTooling.push(best.number);
    }
  }
  for (const c of candidates.filter((c) => eligible(c) && c.lane === "product" && c.tier === "blocks_milestone").sort(productBlocker)) {
    if (now.size < 8 || displace(`displaced_by_blocker:${c.number}`)) add(c, "blocker");
  }
  for (const c of candidates.filter((c) => eligible(c) && c.lane === "product" && c.tier === "v1_not_blocking" && c.score !== null).sort(formula)) {
    if (now.size >= 5) break; add(c, "formula");
  }
  const unranked = candidates.filter((c) => c.issue.status !== "closed" && (!c.covered || c.tier === null)).map((c) => c.number);
  const disagreements: { issueNumber: number; field: string; current: string | null; proposed: string | null; reason: string }[] = [];
  const priorityClears: { issueNumber: number; current: string; cohort: "new" | "existing"; disposition: Target["disposition"]; reason: string }[] = [];
  const issues = candidates.map((c): PreviousIssue & { classification: string; coverageOutcome?: Issue["coverageOutcome"]; targets: Target[] } => {
    const i = c.issue; const targets: Target[] = [];
    let sortKey: number | null = null;
    const proposeSortKey = (horizon: string | null) => {
      const current = i.fields["Sort key"];
      if (!writesSortKey || i.status === "closed") return;
      const value = sortKey = stewardshipRankKey({ horizon, nowReason: now.get(c.number)?.reason ?? "legacy_now_unranked",
        covered: c.covered, tier: c.tier, value: c.value, effort: c.effort });
      if (current === undefined || current === value) return;
      const previous = c.previous?.sortKey !== undefined ? c.previous.sortKey : c.previous?.targets?.find((target) => target.field === "Sort key")?.value;
      const reason = current !== null && previous !== undefined && current !== previous ? "overwrite_external_edit" : "computed_sort_key";
      targets.push({ field: "Sort key", current, value,
        disposition: ordinaryStatus === "ready" && (!input.coveredOnly || c.covered) ? "executable" : "report_only",
        reason: ordinaryStatus === "ready" ? reason : `${ordinaryStatus}:${reason}` });
    };
    // Coverage alone grants no assessment proposal; the sorter-owned key still reflects an unranked issue.
    if (i.coverageOutcome) {
      proposeSortKey(i.fields.Horizon);
      return { issueNumber: c.number, classification: "glm_refused", coverageOutcome: i.coverageOutcome,
      horizon: i.fields.Horizon, reason: "local_path", tier: null, severity: null, currencyKey: null,
      lifecycleReopenCurrencyKey: c.previous?.lifecycleReopenCurrencyKey ?? null,
      ...(writesSortKey && i.status !== "closed" ? { sortKey } : {}), targets };
    }
    const propose = (field: Field, value: string | null, reason: string, permitted = true) => {
      const current = i.fields[field];
      if (field === "Lifecycle" && current !== null && value === current && (i.lifecycleReceiptAt === null || i.lifecycleWithoutReceipt)) reason = "lifecycle_without_receipt";
      const safeLifecycleClear = field === "Lifecycle" && value === null && reason === "reopened_after_flag";
      const historyClear = field === "Lifecycle" && reason === "lifecycle_history_incomplete";
      const targetStatus = safeLifecycleClear ? status : ordinaryStatus;
      const disposition = targetStatus === "ready" && i.status !== "closed" && permitted && value !== current
        && (!input.coveredOnly || !historyClear)
        && (!input.coveredOnly || c.covered || safeLifecycleClear) ? "executable" : "report_only";
      const target: Target = { field, current, value, disposition,
        reason: targetStatus !== "ready" ? `${targetStatus}:${reason}` : i.status === "closed" ? "closed" : reason };
      if (field === "Lifecycle" && current !== null && value === null) targets.unshift(target);
      else targets.push(target);
      return target;
    };
    const ranking = i.assessment?.ranking;
    const reopen = [...i.reopens].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || canonicalOrder(a, b)).at(-1);
    const reopenClear = needsReopenClear(i);
    const historyClear = needsHistoryClear(i);
    let lifecycleReopenCurrencyKey = c.previous?.lifecycleReopenCurrencyKey ?? null;
    // A stale/unassessed reopen has no current currency to compare. Bank the next
    // current assessment as the baseline, holding until a later substantive change.
    if (lifecycleReopenCurrencyKey === "awaiting_current_assessment" && i.assessment) lifecycleReopenCurrencyKey = i.assessment.currencyKey;
    if (reopenClear || historyClear) {
      propose("Lifecycle", null, reopenClear ? "reopened_after_flag" : "lifecycle_history_incomplete");
      if (reopenClear) lifecycleReopenCurrencyKey = i.assessment?.currencyKey ?? "awaiting_current_assessment";
    }
    let horizon = i.fields.Horizon; let horizonReason = "unchanged";
    if (i.status === "closed") horizonReason = "closed";
    else if (i.pins.Horizon) { horizon = i.pins.Horizon.value; horizonReason = "pinned"; }
    else if (!c.covered) horizonReason = "unranked";
    else if (now.has(c.number)) { horizon = "Now"; horizonReason = now.get(c.number)!.reason; }
    else if (exits.get(c.number) === "both_seats_done_stale") { horizon = "Later"; horizonReason = "both_seats_done_stale"; }
    else if (exits.has(c.number) && c.tier === null) { horizon = "Next"; horizonReason = "exited_tier_needs_evidence"; }
    else if (c.flagged && !c.incumbent) horizonReason = "flagged_keep_horizon";
    else if (c.tier === null) horizonReason = "tier_needs_evidence";
    else { horizon = c.tier === "blocks_milestone" ? "Next" : c.tier === "v1_not_blocking" ? "Later" : "Parked"; horizonReason = exits.get(c.number) ?? (c.tier === "not_v1" ? "Milestone 1 complete" : "by_tier"); }
    if (input.previous === null && i.status !== "closed" && !i.pins.Horizon && !now.has(c.number)
      && horizon === "Now" && (!c.covered || c.flagged || c.tier === null)) horizonReason = "legacy_now_unranked";
    propose("Horizon", horizon, horizonReason, c.covered && !i.pins.Horizon);
    proposeSortKey(horizon);
    const effort = c.effort === null ? null : c.effort[0].toUpperCase() + c.effort.slice(1);
    if (i.pins.Effort) {
      propose("Effort", i.pins.Effort.value, "pinned", false);
      if (effort !== null && effort !== i.pins.Effort.value) disagreements.push({ issueNumber: c.number, field: "Effort", current: i.fields.Effort, proposed: effort, reason: "effort_pinned" });
    }
    else if (effort !== null && (i.fields.Effort === null || i.effortWriter === "sorter")) propose("Effort", effort, "merged_effort", c.covered);
    else {
      propose("Effort", i.fields.Effort, effort === null ? "effort_needs_evidence" : "effort_owned_elsewhere", false);
      if (effort !== null && effort !== i.fields.Effort) disagreements.push({ issueNumber: c.number, field: "Effort", current: i.fields.Effort, proposed: effort, reason: `writer:${i.effortWriter}` });
    }
    const code = i.assessment?.phaseBVerified === true && i.assessment.phase === "expanded";
    const excerptCapturedAt = i.assessment?.excerptCapturedAt ?? null;
    if (c.severity === "none" && i.fields.Priority !== null) {
      const cohort = newPriorityCohort(c, input.filingFieldReceipts) ? "new" : "existing";
      const demotion = !["P0", "P1"].includes(i.fields.Priority) || typedDemotion(c);
      const reason = input.filingFieldReceipts === undefined || input.filingFieldReceipts.length === 0 ? "no_filing_receipt"
        : cohort === "existing" && input.filingFieldReceipts.some((receipt) => receipt.issueNumber === c.number && receipt.value === i.fields.Priority
          && receipt.eventId === undefined) ? "filing_receipt_without_event_id"
        : cohort === "existing" ? "priority_clear_existing_cohort" : !code ? "priority_clear_needs_code" : !input.firstApprovedCycleCompleted ? "priority_clear_first_cycle"
        : !demotion ? "priority_clear_needs_demotion" : "priority_clear_filing_stamp";
      const t = propose("Priority", null, reason, code && cohort === "new" && input.firstApprovedCycleCompleted && demotion);
      priorityClears.push({ issueNumber: c.number, current: i.fields.Priority, cohort, disposition: t.disposition, reason: t.reason });
    } else if (c.severity !== null && c.severity !== "none" && code) {
      const demotion = i.fields.Priority !== null && ["P0", "P1"].includes(i.fields.Priority) && c.severity > i.fields.Priority;
      propose("Priority", c.severity, demotion && !typedDemotion(c) ? "priority_needs_demotion" : "code_evidenced_severity", !demotion || typedDemotion(c));
    } else propose("Priority", i.fields.Priority, c.severity === null ? "severity_needs_evidence" : "no_code_evidenced_priority", false);
    for (const field of ["effort", "severity"] as const) if (ranking?.[field].status === "needs_evidence" && ranking[field].cause === "disagreed") {
      disagreements.push({ issueNumber: c.number, field: field === "effort" ? "Effort" : "Priority", current: field === "effort" ? i.fields.Effort : i.fields.Priority, proposed: null, reason: "seats_disagreed" });
    }
    if (!reopenClear && !historyClear) {
      const flags = ranking?.doneStale.seats;
      const same = flags?.length === 2 && flags[0].status === "assessed" && flags[1].status === "assessed" && flags[0].value === flags[1].value ? flags[0].value : null;
      const desired = same === "done" ? "Done candidate" : same === "stale" ? "Stale candidate" : null;
      const contrary = same !== null && i.fields.Lifecycle !== null && desired !== i.fields.Lifecycle;
      if (i.fields.Lifecycle !== null && (c.pinned || c.severity === "P0" || contrary)) propose("Lifecycle", null, c.pinned ? "lifecycle_pin" : c.severity === "P0" ? "lifecycle_agreed_p0" : "lifecycle_contrary");
      else if (i.reopenHistoryComplete !== true || i.lifecycleHistoryComplete !== true) propose("Lifecycle", null, "lifecycle_history_incomplete", i.fields.Lifecycle !== null);
      else if (desired !== null && !c.pinned && c.severity !== "P0" && (same !== "done" || (code && excerptCapturedAt !== null))
        && (!reopen || (code && excerptCapturedAt !== null && Date.parse(excerptCapturedAt) > Date.parse(reopen.createdAt)))
        && (lifecycleReopenCurrencyKey === null || lifecycleReopenCurrencyKey !== i.assessment?.currencyKey)) propose("Lifecycle", desired, "lifecycle_agreed_flag");
      else propose("Lifecycle", i.fields.Lifecycle, i.fields.Lifecycle !== null && i.lifecycleReceiptAt === null ? "lifecycle_without_receipt" : "lifecycle_hold", false);
    }
    if (startCommand && i.status !== "closed") {
      if (!i.startCommandFacts) throw new Error("v2 compile requires Start command facts");
      const assessment = i.status === "current" ? i.assessment : null;
      const derived = deriveStartCommand({ ...i.startCommandFacts, assessment: assessment ? {
        seats: assessment.assessments.map(({ assessment: seat }) => ({ completion: seat.completion, premise: seat.premise, unresolvedChoices: seat.unresolvedChoices })),
        effort: assessment.ranking.effort,
      } : null });
      const value = derived.kind === "target" ? derived.value : null;
      const row = derived.kind === "target" ? derived.row : null;
      targets.push({ field: "Start command", current: null, value, disposition: "report_only",
        reason: derived.kind === "target" ? `start_command_row_${derived.row}` : `start_command_hold_${derived.reason}` });
      const counts = derived.kind === "target" ? startCommand.counts.byRow : startCommand.counts.holds;
      const key = derived.kind === "target" ? derived.row : derived.reason;
      counts[key] = (counts[key] ?? 0) + 1;
      if (startCommand.sample.length < 20) startCommand.sample.push({ issueNumber: c.number, value, row });
    }
    return { issueNumber: c.number, classification: i.status === "closed" ? "closed" : c.pinned ? "pinned" : c.emergency ? "emergency" : c.flagged ? "flagged" : c.ready ? "ready" : c.incumbent ? "incumbent" : "unranked",
      horizon, reason: horizonReason, tier: c.tier, severity: c.severity, currencyKey: i.assessment?.currencyKey ?? null, lifecycleReopenCurrencyKey,
      ...(writesSortKey && i.status !== "closed" ? { sortKey } : {}), targets };
  });
  const list = [...now.values()].map(({ candidate: c, reason }) => ({ issueNumber: c.number, reason, score: c.score }));
  const resultingNow = new Set(issues.filter((i) => i.horizon === "Now" && candidates.find((c) => c.number === i.issueNumber)!.issue.status !== "closed").map((i) => i.issueNumber));
  for (const c of candidates) if (resultingNow.has(c.number) && !now.has(c.number)) list.push({ issueNumber: c.number, reason: "legacy_now_unranked", score: c.score });
  const sortedBlockers = (values: Issue["blockers"]["gating"]) => [...values].sort(canonicalOrder);
  const executable = issues.flatMap((issue) => issue.targets.filter((target) => target.disposition === "executable"));
  const coverageNotes = [
    ...(!input.projection.coverage.lifecycleReceiptsAvailable && candidates.every((c) => c.issue.lifecycleReceiptAt === null) ? ["lifecycle_receipts_unavailable"] : []),
    ...candidates.filter((c) => needsHistoryClear(c.issue) && !needsReopenClear(c.issue)).map((c) => `history unavailable for #${c.number}`),
    ...(ordinaryStatus !== "ready" && status === "ready" && executable.length > 0
      && executable.every((target) => target.reason === "reopened_after_flag")
      ? [`approving executes only ${executable.length} reopen clears; coverage incomplete`] : []),
  ];
  const report = {
    now: list,
    enteredNow: list.filter((entry) => entry.reason !== "legacy_now_unranked" && !candidates.find((c) => c.number === entry.issueNumber)!.incumbent),
    leftNow: candidates.filter((c) => c.incumbent && !resultingNow.has(c.number)).map((c) => ({ issueNumber: c.number, reason: exits.get(c.number) ?? "left_now" })),
    coverage: { ...input.projection.coverage, unranked: [...input.projection.coverage.unranked].sort((a, b) => a - b),
      notes: coverageNotes }, unranked,
    exitedTierNeedsEvidence: issues.filter((i) => i.reason === "exited_tier_needs_evidence").map((i) => i.issueNumber),
    abstained: candidates.filter((c) => c.issue.assessment && Object.values(c.issue.assessment.ranking).some((f) => "status" in f && f.status === "needs_evidence" && f.cause === "abstained")).map((c) => c.number),
    escalated: candidates.filter((c) => c.issue.assessment?.seats.some((s) => s.codeNeeded.length > 0)).map((c) => c.number),
    flags: candidates.filter((c) => !c.issue.coverageOutcome && (c.flagged || c.issue.fields.Lifecycle !== null)).map((c) => ({ issueNumber: c.number,
      lifecycle: issues.find((i) => i.issueNumber === c.number)!.targets.find((t) => t.field === "Lifecycle")!,
      seats: [...(c.issue.assessment?.seats ?? [])].sort(canonicalOrder).map((s) => ({ family: s.family, doneStale: s.doneStale })) })),
    skippedBlocked: candidates.filter((c) => c.issue.blockers.gating.length && !now.has(c.number)).map((c) => ({ issueNumber: c.number, blockers: sortedBlockers(c.issue.blockers.gating) })),
    emergencyBlockers: candidates.filter((c) => c.emergency && now.has(c.number) && c.issue.blockers.gating.length).map((c) => ({ issueNumber: c.number, blockers: sortedBlockers(c.issue.blockers.gating) })),
    advisoryBlockers: candidates.flatMap((c) => {
      const text = [...new Set(c.issue.assessment?.assessments.flatMap((e) => e.assessment.blockers) ?? [])].sort((a, b) => a - b);
      return text.length || c.issue.blockers.advisory.length ? [{ issueNumber: c.number, native: sortedBlockers(c.issue.blockers.advisory), text }] : [];
    }),
    pinsHonored: candidates.flatMap((c) => (["Horizon", "Effort"] as const).flatMap((field) => c.issue.pins[field] ? [{ issueNumber: c.number, field, ...c.issue.pins[field] }] : [])),
    disagreements, priorityClearCandidates: { count: priorityClears.length, reportOnlyCount: priorityClears.filter((p) => p.disposition === "report_only").length,
      coordinatorCount: priorityClears.filter((p) => p.cohort === "existing").length, entries: priorityClears },
    waitingTooling, unmergedBlockerEffort: candidates.filter((c) => c.tier === "blocks_milestone" && c.effort === null).map((c) => c.number),
    later: candidates.filter((c) => issues.find((i) => i.issueNumber === c.number)?.horizon === "Later").sort(formula).map((c) => ({ issueNumber: c.number, score: c.score })),
    alarms: resultingNow.size > 8 ? [`now_over_capacity:${resultingNow.size}`] : [], refusal,
    ...(startCommand ? { startCommand } : {}),
  };
  const snapshot = { schemaVersion: v2 ? "github-issue-roadmap-backlog-compile/v2" : "github-issue-roadmap-backlog-compile/v1", inputs: snapshotCollections(input), status, issues, report };
  const reportForHash = Object.fromEntries(Object.entries(report).map(([key, value]) =>
    [key, key === "now" || key === "later" ? value : snapshotCollections(value)]));
  return { ...snapshot, snapshotSha256: canonicalJsonSha256({ ...snapshot, report: reportForHash }) };
}

/** Dispositions, rather than the report's proposals, define completion and execution. */
export function stewardshipSnapshotOperations(snapshot: ReturnType<typeof compileStewardshipBacklog>) {
  return snapshot.issues.flatMap((issue) => issue.targets.filter((target) => target.disposition === "executable").map((target) => {
    const field = target.field === "Sort key" ? "sort_key" : target.field.toLowerCase();
    const operation = stewardshipOperationSchema.parse(target.value === null
      ? { kind: `clear_${field}` } : { kind: `set_${field}`, value: target.value });
    return { issueNumber: issue.issueNumber, operation };
  }));
}
