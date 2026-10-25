import { canonicalJsonSha256 } from "./canonical-json";
import { isVerificationFresh, VERIFICATION_MARKER } from "./snapshot-v2";
import { classifyStewardshipAssessmentAgreement, stewardshipAssessmentEnvelopeSchema, stewardshipVisibleFact, validateStewardshipAssessment, validateStewardshipEvidence,
  type StewardshipMergedRanking, type ArchivedStewardshipAssessment, type BoundStewardshipEvidence, type StewardshipAssessment } from "./stewardship-assessment";
import type { StewardshipIssueEvidencePacket } from "./stewardship-evidence";
import { isSnapshotStewardshipPolicy, resolveStewardshipPolicy, type StewardshipOperation, type StewardshipPolicy } from "./stewardship-policy";
import type { StewardshipField, StewardshipHold } from "./stewardship-state";
import type { StewardshipSeatFamily, StewardshipSeatFamilies } from "./stewardship-seat-families";

export interface StewardshipDecisionComment {
  readonly purpose: "verification" | "decision";
  readonly body: string;
  /** Comments are archived as JSON strings, matching StewardshipStore.archive(body). */
  readonly bodySha256: string;
}
export interface StewardshipHoldSupersession {
  readonly field: StewardshipField; readonly previousEvidenceSha256: string; readonly materialEvidenceSha256: string;
  readonly changedFactIds: readonly string[]; readonly assessmentSha256s: readonly [string, string];
}
export const STEWARDSHIP_COMPILER_VERSION = 4;
export { STEWARDSHIP_SEAT_FAMILIES, type StewardshipSeatFamily, type StewardshipSeatFamilies } from "./stewardship-seat-families";
export const STEWARDSHIP_PRODUCTION_SEAT_FAMILIES = ["codex", "glm"] as const satisfies StewardshipSeatFamilies;
/** Missing provenance equals only missing provenance. */
export function sameStewardshipSeatFamilies(left: StewardshipSeatFamilies | undefined, right: StewardshipSeatFamilies | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left[0] === right[0] && left[1] === right[1];
}
/** The compiler provenance a journal event copies from the decision that authorized it. */
export function stewardshipDecisionProvenance(decision: { readonly compilerVersion?: number; readonly seatFamilies?: StewardshipSeatFamilies }):
  { compilerVersion?: number; seatFamilies?: [StewardshipSeatFamily, StewardshipSeatFamily] } {
  return { ...(decision.compilerVersion === undefined ? {} : { compilerVersion: decision.compilerVersion }),
    ...(decision.seatFamilies === undefined ? {} : { seatFamilies: [decision.seatFamilies[0], decision.seatFamilies[1]] }) };
}
export const STEWARDSHIP_DIVERGENCE_KEYS = ["unresolvedChoices", "clauseStatuses", "independentlyCloseable", "blockers", "rubricFacts",
  "sequencing", "premise", "completion", "demotion", "revisitTrigger"] as const;
export type DivergenceKey = typeof STEWARDSHIP_DIVERGENCE_KEYS[number];
export interface StewardshipDecision {
  readonly schemaVersion: "github-issue-roadmap-stewardship-decision/v1";
  /** Missing on archived v1 decisions. Invalid/deferred inputs may lack a seat pair. */
  readonly compilerVersion?: number;
  readonly seatFamilies?: StewardshipSeatFamilies;
  readonly issueNumber: number;
  readonly materialEvidenceSha256: string;
  readonly assessmentSha256s: readonly string[];
  readonly status: "eligible" | "no-change" | "deferred" | "escalated";
  readonly reasons: readonly string[];
  readonly operations: readonly StewardshipOperation[];
  readonly comments: readonly StewardshipDecisionComment[];
  readonly holdSupersessions: readonly StewardshipHoldSupersession[];
  readonly divergence: { readonly differingKeys: readonly DivergenceKey[]; readonly clauseIds: readonly string[] } | null;
  readonly ranking?: StewardshipMergedRanking;
  readonly path?: "awaiting_backlog_compile";
}
export interface CompileStewardshipDecisionOptions {
  readonly evidence: BoundStewardshipEvidence; readonly policy: StewardshipPolicy;
  readonly assessments: readonly ArchivedStewardshipAssessment[];
  readonly now: string;
  /** Complete live count, including unassessed issues. Pending demotions never reduce this number. */
  readonly census: { readonly complete: boolean; readonly nowCount: number };
  readonly holds?: Partial<Record<StewardshipField, StewardshipHold | null>>;
  /** Immutable contemporaneous packets recovered by their recorded material identity. */
  readonly heldEvidence?: Readonly<Record<string, BoundStewardshipEvidence>>;
  readonly releasedAt?: Partial<Record<StewardshipField, string | null>>;
}

function hasCodeProof(packet: StewardshipIssueEvidencePacket, assessment: StewardshipAssessment): boolean {
  return packet.clauses.length > 0 && packet.clauses.every((clause) => clause.coverage === "source_collected"
    && assessment.clauses.some((entry) => entry.clauseId === clause.clauseId && entry.status !== "unknown" && entry.codeReferences.length > 0))
    && assessment.clauses.some((clause) => clause.status === "unfulfilled");
}
function rubricMet(assessment: StewardshipAssessment): boolean {
  const keys: Record<NonNullable<StewardshipAssessment["proposed"]["Priority"]>, readonly (keyof StewardshipAssessment["rubricFacts"])[]> = {
    P0: ["reachableProduction", "invariant", "blastRadius", "directProof", "confirmingCheck", "whyP1Unsafe"],
    P1: ["coreJourneyOrLaunchGateOrConflictingTruth", "strategyTrack", "impact", "dependencyPosition", "confirmingCheck"],
    P2: ["remainingGap", "impact"], P3: ["closeableOutcome", "worthwhile"],
  };
  return assessment.proposed.Priority === null || keys[assessment.proposed.Priority].every((key) => assessment.rubricFacts[key] !== null);
}

/** Record concerns: keys that differ, plus unresolved choices whenever present. Only field names and clause IDs are returned. */
function assessmentDivergence(left: StewardshipAssessment, right: StewardshipAssessment): StewardshipDecision["divergence"] {
  const evidenceIds = (value: { evidenceIds: string[] } | null) => value === null ? null : [...value.evidenceIds].sort();
  const key = (value: StewardshipAssessment): Record<DivergenceKey, unknown> => ({
    unresolvedChoices: [...value.unresolvedChoices].sort(),
    clauseStatuses: value.clauses.map(({ clauseId, status }) => ({ clauseId, status })).sort((a, b) => a.clauseId.localeCompare(b.clauseId)),
    independentlyCloseable: value.independentlyCloseable, blockers: [...value.blockers].sort((a, b) => a - b),
    rubricFacts: Object.fromEntries(Object.entries(value.rubricFacts).map(([name, fact]) => [name, evidenceIds(fact)])),
    sequencing: { disposition: value.sequencing.disposition, evidenceIds: evidenceIds(value.sequencing) }, premise: value.premise, completion: value.completion,
    demotion: value.demotion === null ? null : { kind: value.demotion.kind, evidenceIds: evidenceIds(value.demotion) }, revisitTrigger: evidenceIds(value.revisitTrigger),
  });
  const leftKey = key(left); const rightKey = key(right);
  const differingKeys = (Object.keys(leftKey) as DivergenceKey[]).filter((name) =>
    (name === "unresolvedChoices" && (left.unresolvedChoices.length > 0 || right.unresolvedChoices.length > 0))
    || canonicalJsonSha256(leftKey[name]) !== canonicalJsonSha256(rightKey[name])).sort();
  if (differingKeys.length === 0) return null;
  const leftStatuses = new Map(left.clauses.map(({ clauseId, status }) => [clauseId, status]));
  const rightStatuses = new Map(right.clauses.map(({ clauseId, status }) => [clauseId, status]));
  const clauseIds = [...new Set([...leftStatuses.keys(), ...rightStatuses.keys()])].filter((id) => leftStatuses.get(id) !== rightStatuses.get(id)).sort();
  return { differingKeys, clauseIds };
}

function holdSupersession(options: CompileStewardshipDecisionOptions, field: StewardshipField, hold: StewardshipHold): StewardshipHoldSupersession | null {
  if (hold.kind !== "operator" || !hold.frontier.complete || Date.parse(hold.at) >= Date.parse(options.now)) return null;
  const previous = options.heldEvidence?.[hold.materialEvidenceSha256];
  if (!previous || previous.packet.materialEvidenceSha256 !== hold.materialEvidenceSha256 || previous.packet.issueNumber !== options.evidence.packet.issueNumber) return null;
  validateStewardshipEvidence(previous, resolveStewardshipPolicy(previous.policySha256, options.policy));
  const current = options.evidence.packet;
  const changed = current.facts.filter((fact) => {
    const old = previous.packet.facts.find((entry) => entry.factId === fact.factId);
    const nextVisible = stewardshipVisibleFact(current, fact);
    const oldVisible = old ? stewardshipVisibleFact(previous.packet, old) : null;
    return oldVisible !== null && nextVisible !== null && oldVisible !== nextVisible;
  }).map((fact) => fact.factId);
  if (changed.length === 0) return null;
  for (const entry of options.assessments) {
    if (Date.parse(entry.envelope.assessedAt) <= Date.parse(hold.at)) return null;
    const claim = entry.envelope.assessment.supersedesHold;
    if (!claim || !claim.previousEvidenceSha256s.includes(hold.materialEvidenceSha256) || claim.changedFactIds.length === 0 || claim.changedFactIds.some((id) => !changed.includes(id))) return null;
  }
  return { field, previousEvidenceSha256: hold.materialEvidenceSha256, materialEvidenceSha256: current.materialEvidenceSha256,
    changedFactIds: [...options.assessments[0].envelope.assessment.supersedesHold!.changedFactIds].sort(),
    assessmentSha256s: [options.assessments[0].sha256, options.assessments[1].sha256] };
}

/** Pure authorization boundary. A serialized decision is never authority: U4 must call this again. */
export function compileStewardshipDecision(options: CompileStewardshipDecisionOptions): StewardshipDecision {
  const { evidence, assessments } = options; const packet = evidence.packet;
  const families = assessments.map((entry) => entry.envelope?.seat?.family).filter((family) => family !== undefined).sort();
  // The immutable assessment envelope selects its compiler. v1 archives replay byte-for-byte as v3.
  const legacy = assessments.length === 2 && assessments.every((entry) => entry.envelope?.schemaVersion === "github-issue-roadmap-stewardship-assessment/v1");
  const provenance = { compilerVersion: legacy ? 3 : STEWARDSHIP_COMPILER_VERSION,
    ...(families.length === 2 ? { seatFamilies: [families[0], families[1]] as StewardshipSeatFamilies } : {}) };
  let divergence: StewardshipDecision["divergence"] = null;
  const result = (status: StewardshipDecision["status"], reasons: string[], operations: StewardshipOperation[] = [], comments: StewardshipDecisionComment[] = [], holdSupersessions: StewardshipHoldSupersession[] = []): StewardshipDecision => ({
    schemaVersion: "github-issue-roadmap-stewardship-decision/v1", ...provenance, issueNumber: packet.issueNumber, materialEvidenceSha256: packet.materialEvidenceSha256,
    assessmentSha256s: assessments.map((entry) => entry.sha256), status, reasons, operations, comments, holdSupersessions,
    divergence: status === "eligible" || status === "no-change" ? divergence : null,
  });
  try {
    const policy = validateStewardshipEvidence(evidence, options.policy);
    if (!Number.isFinite(Date.parse(options.now))) return result("deferred", ["invalid_current_time"]);
    if (assessments.length !== 2 || new Set(assessments.map((entry) => entry.envelope.seat.family)).size !== 2) return result("deferred", ["independent_assessments_required"]);
    const checked = assessments.map((entry) => {
      const envelope = stewardshipAssessmentEnvelopeSchema.parse(entry.envelope);
      if (entry.sha256 !== canonicalJsonSha256(envelope) || Date.parse(envelope.assessedAt) > Date.parse(options.now)) throw new Error("Invalid frozen assessment");
      return validateStewardshipAssessment(envelope.assessment, evidence, policy);
    });
    const [left, right] = checked;
    if (!legacy) {
      if (!("ranking" in left) || !("ranking" in right)) return result("deferred", ["incompatible_assessment_versions"]);
      const agreement = classifyStewardshipAssessmentAgreement(left, right, options);
      const ranked = { ranking: agreement.ranking };
      if (agreement.reason) return { ...result(agreement.path === "escalated" ? "escalated" : "deferred", [agreement.reason]), ...ranked };
      if (packet.issue.v1.state !== "OPEN") return { ...result("deferred", ["issue_not_open"]), ...ranked };
      // U5/U6 alone will compile field writes. No v4 path can reach the legacy operation builder.
      return { ...result("no-change", ["awaiting_backlog_compile"]), ...ranked, path: "awaiting_backlog_compile" as const };
    }
    if (isSnapshotStewardshipPolicy(policy)) return result("deferred", ["approved_snapshot_required"]);
    if (!("proposed" in left) || !("proposed" in right)) return result("deferred", ["incompatible_assessment_versions"]);
    const legacyChecked = [left, right];
    const proposed = left.proposed;
    const incompletePremiseOrCompletionEvidence = () => checked.some((entry) => entry.premise === "uncertain" || entry.completion === "uncertain");
    const incompleteEvidenceCoverage = () => !packet.coverage.sourceComplete || !packet.coverage.fieldHistoryComplete
      || !packet.fieldHistory.Priority.frontier.complete || !packet.fieldHistory.Horizon.frontier.complete;
    const priorityRubricNotProven = () => !legacyChecked.every(rubricMet);
    const parkedWithoutNamedTrigger = () => proposed.Horizon === "Parked" && checked.some((entry) => entry.revisitTrigger === null || entry.sequencing.disposition !== "trigger");
    const agreement = classifyStewardshipAssessmentAgreement(left, right, options);
    if (agreement.reason) return result(agreement.path === "deferred" ? "deferred" : "escalated", [agreement.reason]);
    if (checked.some((entry) => entry.completion === "complete")) return result("escalated", ["already_complete_requires_lifecycle_review"]);
    if (agreement.path !== "no-change" && checked.some((entry) => entry.unresolvedChoices.length > 0)) return result("escalated", ["unresolved_product_choice"]);
    if (checked.some((entry) => entry.premise === "disproved")) return result("escalated", ["premise_requires_rescoping"]);
    // The classifier owns R7's exceptions: a hold, a current Now/Next, completion and a disproved premise never reach this path.
    if (agreement.path === "no-change") {
      if (packet.issue.v1.state !== "OPEN") return result("deferred", ["issue_not_open"]);
      divergence = assessmentDivergence(left, right);
      const concerns: string[] = [];
      if (incompletePremiseOrCompletionEvidence()) concerns.push("concern_incomplete_premise_or_completion_evidence");
      if (incompleteEvidenceCoverage()) concerns.push("concern_incomplete_evidence_coverage");
      if (priorityRubricNotProven()) concerns.push("concern_priority_rubric_not_proven");
      if (parkedWithoutNamedTrigger()) concerns.push("concern_parked_without_named_trigger");
      if (checked.some((entry) => entry.unresolvedChoices.length > 0)) concerns.push("concern_unresolved_product_choice");
      return result("no-change", ["stable_material_decision", ...concerns]);
    }
    if (incompletePremiseOrCompletionEvidence()) return result("deferred", ["incomplete_premise_or_completion_evidence"]);
    divergence = assessmentDivergence(left, right);
    if (packet.issue.v1.state !== "OPEN") return result("deferred", ["issue_not_open"]);
    if (incompleteEvidenceCoverage()) return result("deferred", ["incomplete_evidence_coverage"]);
    if (priorityRubricNotProven()) return result("deferred", ["priority_rubric_not_proven"]);
    if (packet.fields.Priority !== proposed.Priority && (packet.fields.Priority === "P0" || packet.fields.Priority === "P1")
      && proposed.Priority !== null && proposed.Priority > packet.fields.Priority
      && checked.some((entry) => !entry.demotion || entry.demotion.evidenceIds.some((id) => !entry.counterevidenceIds.includes(id)))) return result("deferred", ["sensitive_demotion_requires_counterevidence"]);
    if (parkedWithoutNamedTrigger()) return result("deferred", ["parked_requires_named_trigger"]);
    const executionHorizon = proposed.Horizon === "Now" || proposed.Horizon === "Next";
    if (executionHorizon) {
      if (checked.some((entry) => !entry.independentlyCloseable || entry.blockers.length > 0) || packet.issue.relationships.blockedBy.length > 0) return result("deferred", ["execution_prerequisites_unmet"]);
      if (legacyChecked.some((entry) => !hasCodeProof(packet, entry))) return result("deferred", ["clause_level_code_proof_required"]);
      if (checked.some((entry) => entry.sequencing.evidenceIds.length === 0
        || entry.sequencing.disposition !== (proposed.Horizon === "Now" ? "now" : "after_current"))) return result("deferred", ["explicit_sequencing_required"]);
      if (proposed.Horizon === "Now" && proposed.Priority === null) return result("deferred", ["now_requires_one_priority"]);
      if (proposed.Horizon === "Now" && packet.fields.Horizon !== "Now"
        && (!options.census.complete || !Number.isSafeInteger(options.census.nowCount) || options.census.nowCount < 0 || options.census.nowCount >= policy.limits.nowCapacity)) return result("deferred", ["now_capacity_unavailable"]);
    }
    const fields = (["Priority", "Horizon"] as const).filter((field) => proposed[field] !== packet.fields[field]);
    if (fields.length === 0) return result("no-change", ["stable_material_decision"]);
    const supersessions: StewardshipHoldSupersession[] = [];
    // An intervention protects the issue decision, including a proposal that changes only the other field.
    for (const field of ["Priority", "Horizon"] as const) {
      const released = options.releasedAt?.[field];
      if (released && assessments.some((entry) => Date.parse(entry.envelope.assessedAt) <= Date.parse(released))) return result("deferred", ["release_requires_fresh_assessment"]);
      const hold = options.holds?.[field];
      if (hold) {
        const supersession = holdSupersession(options, field, hold);
        if (!supersession) return result("deferred", [`${field.toLowerCase()}_${hold.kind}_hold`]);
        supersessions.push(supersession);
      }
    }
    const comments: StewardshipDecisionComment[] = []; const operations: StewardshipOperation[] = [];
    const addComment = (purpose: StewardshipDecisionComment["purpose"], body: string) => {
      const bodySha256 = canonicalJsonSha256(body); comments.push({ purpose, body, bodySha256 }); operations.push({ kind: "append_comment", purpose, bodySha256 });
    };
    const hashes = assessments.map((entry) => entry.sha256).join(",");
    if (executionHorizon && fields.includes("Horizon")) {
      // Never claim a new inspection date for a cached assessment.
      const verifiedAt = assessments.map((entry) => entry.envelope.assessedAt).sort()[0];
      if (!isVerificationFresh(verifiedAt, options.now)) return result("deferred", ["code_inspection_requires_refresh"]);
      const clauseProof = canonicalJsonSha256(checked.map((entry) => entry.clauses));
      addComment("verification", [VERIFICATION_MARKER, `origin-main-sha: ${evidence.originMainSha}`, `verified-at: ${verifiedAt}`,
        `check: stewardship current-code inspection; issue=${packet.issueNumber}; evidence=${packet.materialEvidenceSha256}; assessments=${hashes}; clause-proof=${clauseProof}`].join("\n"));
    }
    const sensitive = fields.some((field) => field === "Priority" ? [packet.fields.Priority, proposed.Priority].some((value) => value === "P0" || value === "P1")
      : [packet.fields.Horizon, proposed.Horizon].some((value) => value === "Now" || value === "Parked"));
    if (sensitive) addComment("decision", ["<!-- github-issue-roadmap-stewardship-decision:v1 -->", `Issue: ${packet.issueNumber}`,
      `Priority: ${packet.fields.Priority ?? "unset"} -> ${proposed.Priority ?? "unset"}`, `Horizon: ${packet.fields.Horizon ?? "Inbox"} -> ${proposed.Horizon ?? "Inbox"}`,
      `Current main: ${evidence.originMainSha}`, `Evidence: ${packet.materialEvidenceSha256}`, `Assessments: ${hashes}`].join("\n"));
    if (fields.includes("Priority") && proposed.Priority !== null) operations.push({ kind: "set_priority", value: proposed.Priority });
    if (fields.includes("Horizon") && proposed.Horizon !== null) operations.push({ kind: "set_horizon", value: proposed.Horizon });
    return result("eligible", ["independent_agreement_and_deterministic_gates"], operations, comments, supersessions);
  } catch { return result("deferred", ["invalid_bound_assessment_or_evidence"]); }
}
