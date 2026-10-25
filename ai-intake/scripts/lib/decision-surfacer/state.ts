import { canonicalJsonSha256 } from "../github-issue-roadmap/canonical-json";
import type { JournalTail } from "../github-issue-roadmap/intake-execution-journal";

export const DECISION_SCHEMA = "decision-surfacer/v1" as const;
export const EVENT_KINDS = [
  "run_started", "run_finished", "issue_unmappable", "criterion_minted", "criterion_classified", "criterion_drifted",
  "decision_proposed", "decision_folded", "decision_arbitrated", "decision_queued", "decision_answered",
  "decision_deferred", "decision_recorded", "decision_superseded", "decision_stale", "decision_withdrawn",
  "projection_intent", "projection_posted", "projection_uncertain", "projection_operator_confirmed", "projection_absence_resolved",
  "projection_complete", "projection_evidence", "projection_issue_gone", "projection_issue_closed", "budget_reserved",
] as const;
export type DecisionState = "Proposed" | "Blocked" | "Unmappable" | "Arbitrating" | "Queued" | "Deferred"
  | "Recorded" | "Superseded" | "Stale" | "Withdrawn";
export const DECISION_EDGES: Readonly<Record<DecisionState, readonly DecisionState[]>> = {
  Proposed: ["Blocked", "Unmappable", "Arbitrating", "Queued", "Stale"],
  Blocked: ["Proposed", "Stale"], Unmappable: [], Arbitrating: ["Recorded", "Queued", "Stale"],
  Queued: ["Recorded", "Deferred", "Withdrawn", "Stale"], Deferred: ["Queued", "Proposed", "Stale"],
  Recorded: ["Superseded", "Stale"], Superseded: [], Stale: ["Proposed", "Withdrawn"], Withdrawn: [],
};
export interface ArtifactRef { readonly path: string; readonly sha256: string }
export interface DecisionRef { readonly decisionId: string; readonly revision: number }
export const decisionRef = (d: DecisionRef): DecisionRef => ({ decisionId: d.decisionId, revision: d.revision });
export interface CriterionMember {
  readonly criterionId: string;
  readonly issueNodeId: string;
  readonly textSha256: string;
}
export interface DecisionContract {
  readonly members: readonly CriterionMember[];
  readonly prerequisites: readonly DecisionRef[];
  readonly class: "product" | "technical";
}
export type DecisionRoute = "owner-answered" | "concurred";
export type ReversalStep =
  | ({ readonly kind: "decision_superseded"; readonly reason: string } & DecisionRef)
  | ({ readonly kind: "decision_recorded"; readonly resolution: string; readonly route: "owner-answered" } & DecisionRef)
  | ({ readonly kind: "decision_stale"; readonly staleNotice: string } & DecisionRef);
// This is the canonical JSON carried in a comment; the digest is outside it.
export interface DecisionCommentPayload extends DecisionRef, DecisionContract {
  readonly state: "Recorded" | "Stale";
  readonly resolution: string | null;
  readonly staleNotice: string | null;
  readonly route: DecisionRoute;
}
export interface RebuildEvidence { readonly payload: DecisionCommentPayload; readonly sha256: string }
interface Envelope {
  readonly schema: typeof DECISION_SCHEMA;
  readonly at: string;
  readonly artifacts?: readonly ArtifactRef[];
  // Only rebuild may introduce this evidence. It never pretends to have local artifacts.
  readonly rebuild?: RebuildEvidence;
}
interface ProjectionRef extends DecisionRef { readonly issueNodeId: string; readonly operationId: string }
type EventData =
  | { kind: "run_started"; runId: string; originMainSha: string; slice: readonly { issueNodeId: string; issueNumber: number; bodySha256: string }[] }
  | { kind: "run_finished"; runId: string }
  | { kind: "issue_unmappable"; issueNodeId: string; bodySha256: string; reason: string }
  | ({ kind: "criterion_minted"; bodySha256AtMint: string | null } & CriterionMember)
  | { kind: "criterion_classified"; criterionId: string; bodySha256: string; classification: string; attempt: ArtifactRef; blocker?: DecisionRef }
  | { kind: "criterion_drifted"; criterionId: string; bodySha256: string; reason: string }
  | ({ kind: "decision_proposed" } & DecisionRef & DecisionContract)
  // A same-revision fold maps Proposed to Blocked/Unmappable, or binds fold evidence.
  // A membership change opens the next revision in Proposed and drops the old answer.
  | ({ kind: "decision_folded"; state: "Proposed" | "Blocked" | "Unmappable"; reason?: string } & DecisionRef & DecisionContract)
  | ({ kind: "decision_arbitrated" } & DecisionRef)
  | ({ kind: "decision_queued"; class?: "product" } & DecisionRef)
  | ({ kind: "decision_answered"; answer: string } & DecisionRef)
  | ({ kind: "decision_deferred" | "decision_withdrawn"; reason: string } & DecisionRef)
  | ({ kind: "decision_superseded"; reason: string; reversalBatch?: readonly ReversalStep[] } & DecisionRef)
  | ({ kind: "decision_recorded"; resolution: string; route: DecisionRoute } & DecisionRef)
  | ({ kind: "decision_stale"; staleNotice: string; reversalBatch?: readonly ReversalStep[] } & DecisionRef)
  | ({ kind: "projection_intent"; comment: ArtifactRef } & ProjectionRef)
  | ({ kind: "projection_posted"; commentId: string } & ProjectionRef)
  | ({ kind: "projection_uncertain"; reason: string } & ProjectionRef)
  | ({ kind: "projection_operator_confirmed"; operator: string; outcome: "posted" | "absent" | "issue-gone" | "issue-closed"; commentId?: string } & ProjectionRef)
  | ({ kind: "projection_absence_resolved"; operator: string; reason: "superseded" | "issue-gone" | "issue-closed" | "identity-changed" } & ProjectionRef)
  | ({ kind: "projection_complete"; commentId: string } & ProjectionRef)
  // Late-posted IDs match readback after withdrawal and never restore send authority.
  // Duplicate IDs match readback; deleted IDs were observed previously and are now missing.
  | ({ kind: "projection_evidence"; finding: "duplicate" | "deleted" | "late-posted"; commentIds: readonly string[] } & ProjectionRef)
  | ({ kind: "projection_issue_gone" | "projection_issue_closed"; reason: string } & ProjectionRef)
  | ({ kind: "budget_reserved"; operationIds: readonly string[] } & DecisionRef);
export type DecisionEvent = Envelope & EventData;
type WithoutEnvelope<T> = T extends Envelope ? Omit<T, "schema" | "at"> : never;
export type DecisionEventInput = WithoutEnvelope<DecisionEvent>;

export interface CriterionState extends CriterionMember {
  bodySha256AtMint: string | null;
  state: "minted" | "classified" | "drifted";
  classification?: Extract<DecisionEvent, { kind: "criterion_classified" }>;
  history: DecisionEvent[];
}
export type ProjectionStatus = "unposted" | "intent" | "posted" | "uncertain" | "complete" | "absent" | "issue-gone" | "issue-closed";
export interface ProjectionState extends ProjectionRef {
  state: ProjectionStatus;
  comment?: ArtifactRef;
  commentId?: string;
  intentUsed: boolean;
  history: DecisionEvent[];
}
export interface DecisionRevision extends DecisionRef, DecisionContract {
  state: DecisionState;
  answer?: string;
  resolution?: string;
  staleNotice?: string;
  route?: DecisionRoute;
  history: DecisionEvent[];
}
export interface DecisionHistory {
  current: DecisionRevision;
  revisions: Map<number, DecisionRevision>;
}
export interface DecisionIndex {
  runs: Map<string, { started: Extract<DecisionEvent, { kind: "run_started" }>; finished?: DecisionEvent }>;
  criteria: Map<string, CriterionState>;
  issues: Map<string, Extract<DecisionEvent, { kind: "issue_unmappable" }>>;
  decisions: Map<string, DecisionHistory>;
  projections: Map<string, ProjectionState>;
  reservations: Map<string, Extract<DecisionEvent, { kind: "budget_reserved" }>>;
  records: DecisionEvent[];
}

export class DecisionJournalRefusedError extends Error {
  constructor(message: string) { super(`Decision journal refused: ${message}`); this.name = "DecisionJournalRefusedError"; }
}
function refuse(message: string): never { throw new DecisionJournalRefusedError(message); }
function requireValue(condition: unknown, message: string): asserts condition { if (!condition) refuse(message); }
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
function ref(value: unknown): value is DecisionRef {
  return object(value) && text(value.decisionId) && revision(value.revision);
}
function member(value: unknown): value is CriterionMember {
  return object(value) && text(value.criterionId) && text(value.issueNodeId) && hash(value.textSha256);
}
function contract(value: Record<string, unknown>): boolean {
  return Array.isArray(value.members) && value.members.length > 0 && value.members.every(member)
    && new Set(value.members.map((m) => m.criterionId)).size === value.members.length
    && Array.isArray(value.prerequisites) && value.prerequisites.every(ref)
    && new Set(value.prerequisites.map((r) => canonicalJsonSha256(r))).size === value.prerequisites.length
    && (value.class === "product" || value.class === "technical");
}
export function assertArtifactRef(value: unknown): asserts value is ArtifactRef {
  requireValue(object(value) && text(value.path) && hash(value.sha256), "Artifact reference requires path and SHA-256.");
}
export function verifyPayload(evidence: RebuildEvidence): DecisionCommentPayload {
  requireValue(object(evidence) && object(evidence.payload) && hash(evidence.sha256), "Malformed rebuild evidence.");
  const p = evidence.payload;
  requireValue(ref(p) && contract(p), "Malformed decision comment payload identity or contract.");
  const name = `${p.decisionId} revision ${p.revision}`;
  requireValue(p.state === "Recorded" || p.state === "Stale", `${name}: unsupported comment state.`);
  requireValue(p.route === "owner-answered" || p.route === "concurred", `${name}: invalid route.`);
  requireValue(p.state === "Recorded" ? text(p.resolution) && p.staleNotice === null
    : text(p.staleNotice) && p.resolution === null, `${name}: invalid resolution or stale notice.`);
  requireValue(p.class === "technical" || p.route !== "concurred", `${name}: product decision cannot be concurred.`);
  requireValue(canonicalJsonSha256(p) === evidence.sha256, `${name}: payload self-digest mismatch.`);
  return p;
}

export function assertDecisionTransition(from: DecisionState | null, to: DecisionState): void {
  requireValue(from === null ? to === "Proposed" : DECISION_EDGES[from].includes(to),
    `Illegal decision transition ${from ?? "[start]"} -> ${to}.`);
}
// Keep all 256 bits. IDs are independent of field order, run ID, clock and comment bytes.
export function deriveOperationId(decisionId: string, revisionNumber: number, issueNodeId: string): string {
  requireValue(text(decisionId) && revision(revisionNumber) && text(issueNodeId), "Invalid projection identity.");
  return canonicalJsonSha256({ decisionId, revision: revisionNumber, issueNodeId });
}

export function parseDecisionEvent(value: unknown): DecisionEvent {
  requireValue(object(value), "Event must be an object.");
  requireValue(value.schema === DECISION_SCHEMA, `Wrong schema ${String(value.schema)}.`);
  requireValue(typeof value.kind === "string" && (EVENT_KINDS as readonly string[]).includes(value.kind), `Unknown event kind ${String(value.kind)}.`);
  requireValue(typeof value.at === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value.at)
    && Number.isFinite(Date.parse(value.at)) && new Date(value.at).toISOString().replace(/\.000Z$/, "Z")
      === value.at.replace(/\.(\d{1,3})Z$/, (_, digits: string) => `.${digits.padEnd(3, "0")}Z`).replace(/\.000Z$/, "Z"),
  "Event at must be an ISO UTC timestamp.");
  if ("class" in value && !["decision_proposed", "decision_folded"].includes(String(value.kind))) {
    requireValue(value.kind === "decision_queued" && value.class === "product", `${value.kind}: class change refused.`);
  }
  if (value.artifacts !== undefined) {
    requireValue(Array.isArray(value.artifacts), "artifacts must be an array.");
    value.artifacts.forEach(assertArtifactRef);
  }
  if (value.reversalBatch !== undefined) {
    requireValue(["decision_superseded", "decision_stale"].includes(String(value.kind)) && value.rebuild === undefined,
      "Reversal batch intent requires a local supersession or staleness event.");
    requireValue(Array.isArray(value.reversalBatch) && value.reversalBatch.length >= (value.kind === "decision_stale" ? 1 : 2), "Malformed reversal batch.");
    value.reversalBatch.forEach((step, offset) => {
      requireValue(object(step) && step.kind === (value.kind === "decision_stale" ? "decision_stale"
        : offset === 0 ? "decision_superseded" : offset === 1 ? "decision_recorded" : "decision_stale")
        && step.reversalBatch === undefined && step.rebuild === undefined && step.artifacts === undefined
        && step.schema === undefined && step.at === undefined, "Malformed reversal batch step.");
      parseDecisionEvent({ ...step, schema: DECISION_SCHEMA, at: value.at });
    });
  }
  if (value.rebuild !== undefined) {
    verifyPayload(value.rebuild as RebuildEvidence);
    requireValue(["criterion_minted", "decision_recorded", "decision_stale", "projection_complete"].includes(value.kind),
      `Rebuild evidence is not allowed on ${value.kind}.`);
  }
  if (value.kind.startsWith("decision_") || value.kind.startsWith("projection_") || value.kind === "budget_reserved") {
    requireValue(ref(value), `${value.kind}: decisionId and positive revision required.`);
  }
  if (value.kind.startsWith("projection_")) {
    requireValue(text(value.issueNodeId) && text(value.operationId), `${value.kind}: projection identity required.`);
    requireValue(value.operationId === deriveOperationId(String(value.decisionId), Number(value.revision), value.issueNodeId),
      `${value.kind}: operationId does not match decision, revision and issue.`);
  }
  const needText = (...fields: string[]) => fields.forEach((f) => requireValue(text(value[f]), `${value.kind}: ${f} required.`));
  const needHash = (field: string) => requireValue(hash(value[field]), `${value.kind}: ${field} must be SHA-256.`);
  switch (value.kind) {
    case "run_started":
      needText("runId");
      requireValue(typeof value.originMainSha === "string" && /^[a-f0-9]{40}$/.test(value.originMainSha), "run_started: originMainSha required.");
      requireValue(Array.isArray(value.slice) && value.slice.every((v) => object(v) && text(v.issueNodeId)
        && revision(v.issueNumber) && hash(v.bodySha256)), "run_started: invalid frozen slice.");
      requireValue(new Set(value.slice.map((v) => v.issueNodeId)).size === value.slice.length
        && new Set(value.slice.map((v) => v.issueNumber)).size === value.slice.length, "run_started: duplicate slice issue.");
      break;
    case "run_finished": needText("runId"); break;
    case "issue_unmappable": needText("issueNodeId", "reason"); needHash("bodySha256"); break;
    case "criterion_minted":
      requireValue(member(value), "criterion_minted: invalid criterion identity.");
      requireValue(hash(value.bodySha256AtMint) || (value.bodySha256AtMint === null && value.rebuild !== undefined),
        "criterion_minted: bodySha256AtMint required outside rebuild."); break;
    case "criterion_classified":
      needText("criterionId", "classification"); needHash("bodySha256"); assertArtifactRef(value.attempt);
      if (value.blocker !== undefined) requireValue(ref(value.blocker), "criterion_classified: invalid blocker revision.");
      break;
    case "criterion_drifted": needText("criterionId", "reason"); needHash("bodySha256"); break;
    case "decision_proposed": case "decision_folded":
      requireValue(contract(value), `${value.kind}: invalid decision contract.`);
      if (value.kind === "decision_folded") {
        requireValue(["Proposed", "Blocked", "Unmappable"].includes(String(value.state)), "decision_folded: invalid target state.");
        if (value.state !== "Proposed") needText("reason");
      }
      break;
    case "decision_arbitrated": case "decision_queued":
      requireValue(Array.isArray(value.artifacts) && value.artifacts.length > 0, `${value.kind}: bound artifacts required.`); break;
    case "decision_answered": needText("answer"); break;
    case "decision_deferred": case "decision_superseded": case "decision_withdrawn":
    case "projection_uncertain": case "projection_issue_gone": case "projection_issue_closed": needText("reason"); break;
    case "decision_recorded":
      needText("resolution"); requireValue(value.route === "owner-answered" || value.route === "concurred", "decision_recorded: invalid route."); break;
    case "decision_stale": needText("staleNotice"); break;
    case "projection_intent": assertArtifactRef(value.comment); break;
    case "projection_posted": case "projection_complete": needText("commentId"); break;
    case "projection_evidence":
      requireValue(Object.keys(value).every((key) => ["schema", "at", "kind", "decisionId", "revision", "issueNodeId",
        // rebuildBatch is stamped on every rebuilt record; the fold checks it may only begin a journal.
        "operationId", "finding", "commentIds", "artifacts", "rebuildBatch"].includes(key)), "projection_evidence: unknown field.");
      requireValue(value.finding === "duplicate" || value.finding === "deleted" || value.finding === "late-posted", "projection_evidence: invalid finding.");
      requireValue(Array.isArray(value.commentIds) && value.commentIds.length >= (value.finding === "duplicate" ? 2 : 1)
        && value.commentIds.every(text) && new Set(value.commentIds).size === value.commentIds.length,
      "projection_evidence: unique comment IDs required (at least two for duplicates).");
      if (Array.isArray(value.artifacts)) requireValue(value.artifacts.every((a) => Object.keys(a).every((key) => key === "path" || key === "sha256")),
        "projection_evidence: unknown artifact field.");
      break;
    case "projection_absence_resolved":
      needText("operator");
      requireValue(["superseded", "issue-gone", "issue-closed", "identity-changed"].includes(String(value.reason)),
        "projection_absence_resolved: invalid terminal reason.");
      requireValue(Object.keys(value).every((key) => ["schema", "at", "kind", "decisionId", "revision", "issueNodeId",
        "operationId", "operator", "reason", "artifacts"].includes(key)), "projection_absence_resolved: unknown field.");
      break;
    case "projection_operator_confirmed":
      needText("operator");
      requireValue(["posted", "absent", "issue-gone", "issue-closed"].includes(String(value.outcome)), "Invalid operator confirmation outcome.");
      if (value.outcome === "posted") needText("commentId"); break;
    case "budget_reserved":
      requireValue(Array.isArray(value.operationIds) && value.operationIds.length > 0 && value.operationIds.every(hash)
        && new Set(value.operationIds).size === value.operationIds.length, "budget_reserved: unique operationIds required."); break;
  }
  return value as unknown as DecisionEvent;
}

function sameContract(a: DecisionContract, b: DecisionContract): boolean {
  return memberDigest(a.members) === memberDigest(b.members)
    && canonicalJsonSha256(a.prerequisites) === canonicalJsonSha256(b.prerequisites) && a.class === b.class;
}
function memberDigest(members: readonly CriterionMember[]): string {
  return canonicalJsonSha256([...members].sort((a, b) => a.criterionId.localeCompare(b.criterionId)));
}
function validateMembers(index: DecisionIndex, c: DecisionContract, decisionId: string): void {
  for (const m of c.members) {
    const minted = index.criteria.get(m.criterionId);
    requireValue(minted && minted.issueNodeId === m.issueNodeId && minted.textSha256 === m.textSha256,
      `${decisionId}: member ${m.criterionId} has no matching minted identity.`);
    for (const [otherId, other] of index.decisions) {
      requireValue(otherId === decisionId || ["Withdrawn", "Unmappable", "Superseded"].includes(other.current.state)
        || !other.current.members.some((v) => v.criterionId === m.criterionId), `${m.criterionId}: already belongs to ${otherId}.`);
    }
  }
  for (const prerequisite of c.prerequisites) {
    requireValue(prerequisite.decisionId !== decisionId, `${decisionId}: self prerequisite refused.`);
    requireValue(index.decisions.get(prerequisite.decisionId)?.revisions.has(prerequisite.revision),
      `${decisionId}: missing prerequisite ${prerequisite.decisionId} revision ${prerequisite.revision}.`);
  }
}
function ready(index: DecisionIndex, d: DecisionRevision): void {
  for (const r of d.prerequisites) {
    const current = index.decisions.get(r.decisionId)?.current;
    requireValue(current?.revision === r.revision && current.state === "Recorded",
      `${d.decisionId}: prerequisite ${r.decisionId} revision ${r.revision} is not currently Recorded.`);
  }
}
function openRevision(index: DecisionIndex, event: DecisionEvent & DecisionRef, c: DecisionContract, state: DecisionState): DecisionRevision {
  const history = index.decisions.get(event.decisionId);
  const expected = (history?.current.revision ?? 0) + 1;
  requireValue(event.revision === expected, `${event.decisionId}: revision gap or reuse; expected ${expected}, got ${event.revision}.`);
  requireValue(!history || history.current.class === c.class, `${event.decisionId}: class changes require Arbitrating -> Queued promotion.`);
  validateMembers(index, c, event.decisionId);
  const d: DecisionRevision = { decisionId: event.decisionId, revision: event.revision,
    members: c.members, prerequisites: c.prerequisites, class: c.class, state, history: [] };
  if (history) { history.revisions.set(d.revision, d); history.current = d; }
  else index.decisions.set(d.decisionId, { current: d, revisions: new Map([[d.revision, d]]) });
  return d;
}
function createProjections(index: DecisionIndex, d: DecisionRevision): void {
  for (const issueNodeId of new Set(d.members.map((m) => m.issueNodeId))) {
    const operationId = deriveOperationId(d.decisionId, d.revision, issueNodeId);
    requireValue(!index.projections.has(operationId), `Projection operation ID used twice: ${operationId}.`);
    index.projections.set(operationId, { decisionId: d.decisionId, revision: d.revision, issueNodeId,
      operationId, state: "unposted", intentUsed: false, history: [] });
  }
}

function foldDecision(index: DecisionIndex, event: DecisionEvent & DecisionRef): void {
  const prior = index.decisions.get(event.decisionId)?.current;
  const name = `${event.decisionId} revision ${event.revision}`;
  let d: DecisionRevision;
  if (event.rebuild) {
    const p = verifyPayload(event.rebuild);
    requireValue(p.decisionId === event.decisionId && p.revision === event.revision, `${name}: rebuild identity mismatch.`);
    requireValue(event.kind === "decision_recorded" || event.kind === "decision_stale", `${name}: invalid rebuild decision event.`);
    requireValue(event.kind === "decision_recorded" ? p.state === "Recorded" && p.resolution === event.resolution && p.route === event.route
      : p.state === "Stale" && p.staleNotice === event.staleNotice, `${name}: rebuild payload differs from event.`);
    requireValue(prior ? (p.state === "Stale" ? prior.state === "Recorded" : ["Superseded", "Stale"].includes(prior.state))
      : p.state === "Recorded", `${name}: illegal reconstructed revision transition from ${prior?.state ?? "[start]"} to ${p.state}.`);
    d = openRevision(index, event, p, p.state);
    d.route = p.route;
  } else if (event.kind === "decision_proposed" && (!prior || (prior.state === "Stale" && event.revision !== prior.revision))) {
    assertDecisionTransition(prior?.state ?? null, "Proposed");
    if (prior) requireValue(memberDigest(prior.members) === memberDigest(event.members) && prior.class === event.class,
      `${name}: membership changes require decision_folded.`);
    // Re-decision binds the replacement prerequisite revisions, never the stale ones.
    d = openRevision(index, event, event, "Proposed");
  } else if (event.kind === "decision_folded" && prior && event.revision !== prior.revision) {
    requireValue(!["Superseded", "Withdrawn", "Unmappable"].includes(prior.state), `Illegal decision transition ${prior.state} -> Proposed.`);
    requireValue(event.state === "Proposed" && memberDigest(prior.members) !== memberDigest(event.members),
      `${name}: a membership revision requires changed members and state Proposed.`);
    d = openRevision(index, event, event, "Proposed");
  } else if (event.kind === "decision_stale" && prior) {
    assertDecisionTransition(prior.state, "Stale");
    d = openRevision(index, event, prior, "Stale");
    // Unrecorded owner packets still need a route for their stale projection.
    d.route = prior.route ?? "owner-answered";
  } else if (event.kind === "decision_withdrawn" && prior?.state === "Stale") {
    assertDecisionTransition(prior.state, "Withdrawn");
    d = openRevision(index, event, prior, "Withdrawn");
  } else if (event.kind === "decision_recorded" && prior?.state === "Superseded" && event.revision !== prior.revision) {
    // Reversal is explicitly a pair: Superseded at n, Recorded at n + 1.
    requireValue(event.route === "owner-answered", `${name}: reversal requires an owner answer.`);
    d = openRevision(index, event, prior, "Recorded");
    d.answer = event.resolution;
  } else {
    requireValue(prior, `${name}: no Proposed revision.`);
    requireValue(event.revision === prior.revision, `${name}: revision gap or reuse; current revision is ${prior.revision}.`);
    d = prior;
    switch (event.kind) {
      case "decision_proposed":
        requireValue(d.state !== "Stale", `${name}: Stale -> Proposed requires a new revision.`);
        assertDecisionTransition(d.state, "Proposed");
        requireValue(sameContract(d, event), `${name}: membership changes require a new revision.`); d.state = "Proposed"; break;
      case "decision_folded":
        requireValue(sameContract(d, event), `${name}: membership changes require a new revision.`);
        if (event.state === "Proposed") {
          requireValue(d.state === "Proposed" && !d.history.some((e) => e.kind === "decision_folded"), `Illegal decision transition ${d.state} -> Proposed (repeated fold).`);
        } else { assertDecisionTransition(d.state, event.state); d.state = event.state; }
        break;
      case "decision_arbitrated":
        assertDecisionTransition(d.state, "Arbitrating"); requireValue(d.class === "technical", `${name}: only technical decisions arbitrate.`);
        ready(index, d); d.state = "Arbitrating"; break;
      case "decision_queued":
        assertDecisionTransition(d.state, "Queued");
        requireValue(d.state !== "Proposed" || d.class === "product", `${name}: technical decisions require arbitration before queueing.`);
        if (event.class !== undefined) {
          requireValue(d.state === "Arbitrating" && d.class === "technical", `${name}: class changes require Arbitrating -> Queued promotion.`);
        }
        ready(index, d);
        if (event.class === "product") Object.assign(d, { class: "product" });
        d.state = "Queued"; break;
      case "decision_answered":
        requireValue(d.state === "Queued" && d.answer === undefined, `Illegal decision transition ${d.state} -> Answered (answer already present or not queued).`);
        d.answer = event.answer; break;
      case "decision_deferred":
        assertDecisionTransition(d.state, "Deferred"); requireValue(d.answer === undefined, `${name}: answered decision cannot be deferred.`); d.state = "Deferred"; break;
      case "decision_recorded":
        assertDecisionTransition(d.state, "Recorded"); ready(index, d);
        requireValue(d.state === "Queued" ? event.route === "owner-answered" && d.answer === event.resolution
          : event.route === "concurred" && d.class === "technical", `${name}: resolution does not match answer or arbitration route.`);
        d.state = "Recorded"; break;
      case "decision_superseded": assertDecisionTransition(d.state, "Superseded"); d.state = "Superseded"; break;
      case "decision_withdrawn": assertDecisionTransition(d.state, "Withdrawn"); d.state = "Withdrawn"; break;
      default: refuse(`${name}: invalid decision event ${event.kind}.`);
    }
  }
  if (event.kind === "decision_recorded") {
    if (!event.rebuild) ready(index, d);
    d.resolution = event.resolution; d.route = event.route;
    if (event.rebuild && event.route === "owner-answered") d.answer = event.resolution;
    createProjections(index, d);
  }
  if (event.kind === "decision_stale") { d.staleNotice = event.staleNotice; createProjections(index, d); }
  d.history.push(event);
}

function foldProjection(index: DecisionIndex, e: DecisionEvent & ProjectionRef): void {
  const p = index.projections.get(e.operationId);
  requireValue(p, `${e.operationId}: projection has no Recorded or Stale revision.`);
  const allow = (...states: ProjectionStatus[]) => requireValue(states.includes(p.state), `Illegal projection transition ${p.state} -> ${e.kind} (${e.operationId}).`);
  const comment = (id: string) => {
    requireValue(p.commentId === undefined || p.commentId === id, `${e.operationId}: conflicting comment ID.`);
    p.commentId = id;
  };
  switch (e.kind) {
    case "projection_intent":
      requireValue(!p.intentUsed, `Projection operation ID used twice: ${e.operationId}.`);
      allow("unposted"); p.intentUsed = true; p.comment = e.comment; p.state = "intent"; break;
    case "projection_posted": allow("intent", "uncertain"); comment(e.commentId); p.state = "posted"; break;
    case "projection_uncertain": allow("intent", "posted"); p.state = "uncertain"; break;
    case "projection_operator_confirmed":
      allow("uncertain");
      if (e.outcome === "posted") { comment(e.commentId!); p.state = "posted"; }
      else if (e.outcome === "absent") {
        const current = index.decisions.get(p.decisionId)!.current;
        requireValue(current.revision === p.revision && ["Recorded", "Stale"].includes(current.state),
          `${e.operationId}: historical projection cannot authorize a retry.`);
        requireValue(p.commentId === undefined, `${e.operationId}: a known comment cannot be reposted after deletion.`);
        // Retry the existing persisted intent; never mint a second operation ID.
        p.state = "intent";
      } else p.state = e.outcome;
      break;
    case "projection_absence_resolved": {
      allow("uncertain");
      const current = index.decisions.get(p.decisionId)!.current;
      requireValue(e.reason !== "superseded" || current.revision !== p.revision || current.state === "Superseded",
        `${e.operationId}: projection is still current.`);
      // An operator closes uncertainty without granting another send, even if
      // the issue later reopens. Keep the original intent and receipt as evidence.
      p.state = "absent";
      break;
    }
    case "projection_complete":
      if (e.rebuild) {
        allow("unposted");
        const payload = verifyPayload(e.rebuild);
        const d = index.decisions.get(e.decisionId)?.revisions.get(e.revision);
        requireValue(payload.decisionId === e.decisionId && payload.revision === e.revision && d
          && sameContract(d, payload) && d.route === payload.route && (payload.state === "Recorded" ? d.resolution === payload.resolution : d.staleNotice === payload.staleNotice)
          && payload.members.some((m) => m.issueNodeId === e.issueNodeId), `${e.operationId}: rebuild projection payload mismatch.`);
        p.intentUsed = true;
      } else allow("posted");
      comment(e.commentId); p.state = "complete"; break;
    case "projection_evidence": {
      allow(e.finding === "late-posted" ? "absent" : "complete");
      if (e.finding === "deleted") {
        const observed = new Set([p.commentId, ...p.history.flatMap((event) =>
          event.kind === "projection_evidence" && event.finding === "duplicate" ? event.commentIds : [])]);
        requireValue(e.commentIds.every((id) => observed.has(id)), `${e.operationId}: deletion has no previously observed comment ID.`);
      }
      // Evidence is visible in history without changing state or send authority.
      break;
    }
    case "projection_issue_gone": case "projection_issue_closed":
      allow("unposted", "intent", "posted"); p.state = e.kind === "projection_issue_gone" ? "issue-gone" : "issue-closed"; break;
    default: refuse(`Invalid projection event ${e.kind}.`);
  }
  p.history.push(e);
}

function transitiveDependents(index: DecisionIndex, root: DecisionRevision): DecisionRevision[] {
  const affected = new Set([root.decisionId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const { current: d } of index.decisions.values()) {
      if (!affected.has(d.decisionId) && d.prerequisites.some((p) => affected.has(p.decisionId))) {
        affected.add(d.decisionId); changed = true;
      }
    }
  }
  return [...affected].filter((id) => id !== root.decisionId).map((id) => index.decisions.get(id)!.current);
}

/** Use the existing durable batch protocol for recovery as well as owner reversal. */
export function planDecisionStaleness(index: DecisionIndex, decisionId: string, staleNotice: string): ReversalStep[] {
  const root = index.decisions.get(decisionId)?.current;
  requireValue(root?.state === "Recorded" && text(staleNotice), "Recovery requires a recorded decision and stale notice.");
  const dependents = transitiveDependents(index, root).filter((d) => !["Withdrawn", "Superseded", "Unmappable", "Stale"].includes(d.state));
  requireValue(dependents.every((d) => DECISION_EDGES[d.state].includes("Stale")),
    "Cannot recover with an unrecorded dependent: the journal has no transition from that state to Stale.");
  return [root, ...dependents].map((d) => ({ kind: "decision_stale", decisionId: d.decisionId, revision: d.revision + 1,
    staleNotice: d.decisionId === root.decisionId ? staleNotice
      : `Pending re-decision: prerequisite ${root.decisionId} became stale at revision ${root.revision + 1}. Previous answer or packet no longer applies.` }));
}

/** Bind the complete transitive invalidation set before the first reversal write. */
export function planDecisionReversal(index: DecisionIndex, decisionId: string, resolution: string, reason: string) {
  requireValue(text(resolution) && text(reason), "Reversal requires an answer and reason.");
  const root = index.decisions.get(decisionId)?.current;
  requireValue(root?.state === "Recorded", "Only a recorded decision can be reversed.");
  const dependents = transitiveDependents(index, root);
  requireValue(dependents.every((d) => ["Recorded", "Queued", "Deferred", "Stale"].includes(d.state)),
    "Cannot reverse with an unrecorded dependent: the journal has no transition from that state to Stale.");
  const stale = dependents.filter((d) => d.state !== "Stale").map((d) => ({ decisionId: d.decisionId, revision: d.revision + 1 }));
  const recorded = { decisionId: root.decisionId, revision: root.revision + 1 };
  const events: ReversalStep[] = [
    { kind: "decision_superseded", ...decisionRef(root), reason },
    { kind: "decision_recorded", ...recorded, resolution, route: "owner-answered" },
    ...stale.map((d): ReversalStep => ({ kind: "decision_stale", ...d,
      staleNotice: `Pending re-decision: prerequisite ${root.decisionId} was reversed at revision ${recorded.revision}. Previous answer or packet no longer applies.` })),
  ];
  return { recorded, stale, events };
}

/** Only the claim holder may persist this suffix, after validating the completed fold. */
export function pendingDecisionReversalRecords(records: readonly unknown[], tail: JournalTail | null = null): DecisionEvent[] {
  if (tail !== null) refuse(`Torn final journal line (${tail.bytes.length} bytes); no truncation or execution permitted.`);
  let remaining: DecisionEvent[] = [];
  for (const raw of records) {
    const e = parseDecisionEvent(raw);
    if ((e.kind === "decision_superseded" || e.kind === "decision_stale") && e.reversalBatch !== undefined) {
      requireValue(remaining.length === 0, "Nested reversal batch refused.");
      remaining = e.reversalBatch.map((step) => ({ ...step, schema: DECISION_SCHEMA, at: e.at }));
    }
    if (remaining.length) {
      const actual: Record<string, unknown> = { ...e };
      delete actual.reversalBatch;
      // Recovery retains the intent's timestamp; normal appends may have later clocks.
      actual.at = remaining[0].at;
      requireValue(canonicalJsonSha256(actual) === canonicalJsonSha256(remaining[0]), "Reversal batch event mismatch.");
      remaining = remaining.slice(1);
    }
  }
  return remaining;
}

export function foldDecisionJournal(records: readonly unknown[], tail: JournalTail | null = null): DecisionIndex {
  if (tail !== null) refuse(`Torn final journal line (${tail.bytes.length} bytes); no truncation or execution permitted.`);
  requireValue(pendingDecisionReversalRecords(records, tail).length === 0,
    "Incomplete reversal batch; reacquire the journal claim to recover before consuming decisions.");
  // Import batches must be complete before their prefix can authorize execution.
  const first = records[0];
  if (object(first) && first.rebuildBatch !== undefined) {
    const batch = first.rebuildBatch;
    requireValue(object(batch) && hash(batch.digest) && revision(batch.count) && batch.index === 0, "Malformed rebuild batch header.");
    requireValue(records.length >= batch.count, `Incomplete rebuild batch: expected ${batch.count} records, found ${records.length}.`);
    const contents = records.slice(0, batch.count).map((raw, index) => {
      requireValue(object(raw) && object(raw.rebuildBatch) && raw.rebuildBatch.digest === batch.digest
        && raw.rebuildBatch.count === batch.count && raw.rebuildBatch.index === index, `Malformed rebuild batch at row ${index + 1}.`);
      const event = { ...raw };
      delete event.rebuildBatch;
      return event;
    });
    requireValue(canonicalJsonSha256(contents) === batch.digest, "Rebuild batch digest mismatch.");
    requireValue(records.slice(batch.count).every((r) => !object(r) || r.rebuildBatch === undefined), "Rebuild batch may only begin a journal.");
  } else requireValue(records.every((r) => !object(r) || r.rebuildBatch === undefined), "Rebuild batch may only begin a journal.");
  const index: DecisionIndex = { runs: new Map(), criteria: new Map(), issues: new Map(), decisions: new Map(),
    projections: new Map(), reservations: new Map(), records: [] };
  for (const [offset, raw] of records.entries()) {
    try {
      // Own the snapshot: later caller mutation must not change folded history.
      const e = parseDecisionEvent(JSON.parse(JSON.stringify(raw)) as unknown);
      if (e.kind === "decision_superseded" && e.reversalBatch !== undefined) {
        const replacement = e.reversalBatch[1];
        requireValue(replacement.kind === "decision_recorded", "Reversal batch replacement required.");
        const expected = planDecisionReversal(index, e.decisionId, replacement.resolution, e.reason);
        requireValue(canonicalJsonSha256(expected.events) === canonicalJsonSha256(e.reversalBatch),
          "Reversal batch must bind the replacement and complete dependent invalidation set.");
      }
      if (e.kind === "decision_stale" && e.reversalBatch !== undefined) {
        requireValue(canonicalJsonSha256(planDecisionStaleness(index, e.decisionId, e.staleNotice)) === canonicalJsonSha256(e.reversalBatch),
          "Recovery batch must bind the complete dependent invalidation set.");
      }
      switch (e.kind) {
        case "run_started":
          requireValue(!index.runs.has(e.runId), `Run ${e.runId} already started.`);
          index.runs.set(e.runId, { started: e }); break;
        case "run_finished": {
          const run = index.runs.get(e.runId);
          requireValue(run && !run.finished, `Run ${e.runId} not started or already finished.`); run.finished = e; break;
        }
        case "issue_unmappable": index.issues.set(e.issueNodeId, e); break;
        case "criterion_minted":
          requireValue(!index.criteria.has(e.criterionId), `Criterion ID reused: ${e.criterionId}.`);
          if (e.rebuild) requireValue(verifyPayload(e.rebuild).members.some((m) => m.criterionId === e.criterionId
            && m.issueNodeId === e.issueNodeId && m.textSha256 === e.textSha256), `Criterion ${e.criterionId}: rebuild identity mismatch.`);
          index.criteria.set(e.criterionId, { criterionId: e.criterionId, issueNodeId: e.issueNodeId,
            textSha256: e.textSha256, bodySha256AtMint: e.bodySha256AtMint, state: "minted", history: [e] }); break;
        case "criterion_classified": case "criterion_drifted": {
          const c = index.criteria.get(e.criterionId);
          requireValue(c, `Unknown criterion ${e.criterionId}.`);
          if (e.kind === "criterion_classified") { c.state = "classified"; c.classification = e; }
          else { c.state = "drifted"; delete c.classification; }
          c.history.push(e); break;
        }
        case "budget_reserved":
          for (const op of e.operationIds) {
            const p = index.projections.get(op);
            requireValue(p && p.decisionId === e.decisionId && p.revision === e.revision && p.state === "unposted",
              `Budget reservation has no unposted projection: ${op}.`);
            requireValue(!index.reservations.has(op), `Budget already reserved for ${op}.`);
            index.reservations.set(op, e);
          }
          break;
        default:
          if (e.kind.startsWith("projection_")) foldProjection(index, e as DecisionEvent & ProjectionRef);
          else foldDecision(index, e as DecisionEvent & DecisionRef);
      }
      index.records.push(e);
    } catch (error) {
      throw new DecisionJournalRefusedError(`row ${offset + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return index;
}

export interface VerifiedDecisionComment extends RebuildEvidence {
  readonly issueNodeId: string;
  readonly operationId: string;
  readonly commentId: string;
  readonly at: string;
}

// Author checking and marker parsing belong to U6. This accepts only its
// pre-filtered comments, verifies digests again, and never infers missing revisions.
export function rebuildDecisionRecords(comments: readonly VerifiedDecisionComment[]): DecisionEvent[] {
  const groups = new Map<string, { evidence: RebuildEvidence; comments: VerifiedDecisionComment[] }>();
  const key = (r: DecisionRef) => canonicalJsonSha256({ decisionId: r.decisionId, revision: r.revision });
  const commentIds = new Set<string>();
  for (const c of comments) {
    const p = verifyPayload(c);
    requireValue(text(c.commentId) && p.members.some((m) => m.issueNodeId === c.issueNodeId), `${p.decisionId}: comment issue is not a member.`);
    requireValue(c.operationId === deriveOperationId(p.decisionId, p.revision, c.issueNodeId), `${p.decisionId}: comment operation ID mismatch.`);
    const receipt = canonicalJsonSha256({ operationId: c.operationId, commentId: c.commentId });
    requireValue(!commentIds.has(receipt), `Projection comment ID used twice: ${c.commentId}.`);
    commentIds.add(receipt);
    const existing = groups.get(key(p));
    requireValue(!existing || existing.evidence.sha256 === c.sha256, `${p.decisionId} revision ${p.revision}: conflicting payloads.`);
    if (existing) existing.comments.push(c);
    else groups.set(key(p), { evidence: { payload: p, sha256: c.sha256 }, comments: [c] });
  }
  const requireRevision = (r: DecisionRef) => requireValue(groups.has(key(r)),
    `Rebuild missing verified payload for ${r.decisionId} revision ${r.revision}.`);
  for (const { evidence: { payload: p } } of groups.values()) {
    // Checking the immediate predecessor for every supplied revision proves continuity.
    if (p.revision > 1) requireRevision({ decisionId: p.decisionId, revision: p.revision - 1 });
    p.prerequisites.forEach((r) => {
      requireRevision(r);
      requireValue(groups.get(key(r))!.evidence.payload.state === "Recorded", `${p.decisionId}: prerequisite ${r.decisionId} revision ${r.revision} has no recorded resolution.`);
    });
  }
  const result: DecisionEvent[] = [];
  const minted = new Map<string, CriterionMember>();
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const emit = (r: DecisionRef): void => {
    const identity = key(r);
    if (visited.has(identity)) return;
    requireValue(!visiting.has(identity), `Rebuild prerequisite cycle at ${r.decisionId} revision ${r.revision}.`);
    visiting.add(identity);
    const group = groups.get(identity)!;
    const { payload: p } = group.evidence;
    if (p.revision > 1) emit({ decisionId: p.decisionId, revision: p.revision - 1 });
    p.prerequisites.forEach(emit);
    const base = { schema: DECISION_SCHEMA, at: group.comments[0].at };
    for (const m of p.members) {
      const previous = minted.get(m.criterionId);
      requireValue(!previous || canonicalJsonSha256(previous) === canonicalJsonSha256(m), `Rebuild criterion ${m.criterionId} has conflicting identity.`);
      if (!previous) {
        result.push({ ...base, kind: "criterion_minted", ...m, bodySha256AtMint: null, rebuild: group.evidence });
        minted.set(m.criterionId, m);
      }
    }
    if (p.state === "Recorded" && p.revision > 1
      && groups.get(key({ decisionId: p.decisionId, revision: p.revision - 1 }))!.evidence.payload.state === "Recorded") {
      result.push({ ...base, kind: "decision_superseded", decisionId: p.decisionId, revision: p.revision - 1, reason: "Rebuilt successor revision." });
    }
    result.push(p.state === "Recorded"
      ? { ...base, kind: "decision_recorded", decisionId: p.decisionId, revision: p.revision, resolution: p.resolution!, route: p.route, rebuild: group.evidence }
      : { ...base, kind: "decision_stale", decisionId: p.decisionId, revision: p.revision, staleNotice: p.staleNotice!, rebuild: group.evidence });
    // Rebuild has no local absence history. Every distinct verified receipt is
    // retained as completion or duplicate evidence, including late acceptances.
    const operations = new Map<string, VerifiedDecisionComment[]>();
    for (const c of group.comments) operations.set(c.operationId, [...(operations.get(c.operationId) ?? []), c]);
    for (const receipts of operations.values()) {
      const c = receipts[0];
      const projection = { decisionId: p.decisionId, revision: p.revision, issueNodeId: c.issueNodeId, operationId: c.operationId };
      result.push({ schema: DECISION_SCHEMA, at: c.at, kind: "projection_complete", ...projection,
        commentId: c.commentId, rebuild: group.evidence });
      if (receipts.length > 1) result.push({ schema: DECISION_SCHEMA, at: receipts.at(-1)!.at,
        kind: "projection_evidence", ...projection, finding: "duplicate", commentIds: receipts.map((receipt) => receipt.commentId) });
    }
    visiting.delete(identity); visited.add(identity);
  };
  for (const { evidence } of groups.values()) emit(evidence.payload);
  foldDecisionJournal(result);
  return result;
}
