import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { canonicalJsonSha256, sha256Bytes } from "../lib/github-issue-roadmap/canonical-json";
import { freezeStewardshipAssessment, stewardshipAssessmentSchema, stewardshipAssessmentEnvelopeSchema, classifyStewardshipAssessmentAgreement, type StewardshipAssessment, type StewardshipAssessmentEnvelope as AnyAssessmentEnvelope } from "../lib/github-issue-roadmap/stewardship-assessment";
import { compileStewardshipDecision } from "../lib/github-issue-roadmap/stewardship-decision";
import type { StewardshipIssueEvidencePacket } from "../lib/github-issue-roadmap/stewardship-evidence";
import { resolveStewardshipPolicy } from "../lib/github-issue-roadmap/stewardship-policy";
import { parsePersistedVerificationRecords } from "../lib/github-issue-roadmap/snapshot-v2";
import { assessmentFixture, evidenceFixture, now, policy, rebind } from "./fixtures/roadmap-stewardship";
import type { StewardshipHold } from "../lib/github-issue-roadmap/stewardship-state";

type StewardshipAssessmentEnvelope = Extract<AnyAssessmentEnvelope, { schemaVersion: "github-issue-roadmap-stewardship-assessment/v1" }>;

describe("v4 ranking compiler", () => {
  const currentInput = () => {
    const evidence = evidenceFixture(); const { proposed: _proposed, ...legacy } = assessmentFixture(evidence);
    void _proposed;
    const assessment = stewardshipAssessmentSchema.parse({ ...legacy,
      binding: { ...legacy.binding, rubric: "roadmap-backlog-ranking/v1" }, codeNeeded: [],
      ranking: Object.fromEntries(Object.entries({ lane: "product", tier: "blocks_milestone", milestoneStep: 6,
        value: 8, effort: "medium", severity: "P1", doneStale: "no" }).map(([field, value]) => [field, { status: "assessed", value, rationale: "Current evidence." }])),
    });
    const assessments = (["codex", "glm"] as const).map((family) => freezeStewardshipAssessment({ evidence, policy, assessment,
      seat: { family, requestedModel: family, observedModel: "fixture" }, assessedAt: now }));
    return { evidence, assessments, policy, now, census: { complete: true, nowCount: 0 } };
  };
  it("records the merged ranking on a named non-write path", () => {
    const value = currentInput(); const result = compileStewardshipDecision(value);
    expect(result).toMatchObject({ compilerVersion: 4, status: "no-change", path: "awaiting_backlog_compile",
      reasons: ["awaiting_backlog_compile"], operations: [], comments: [], holdSupersessions: [],
      ranking: { tier: { status: "merged", value: "blocks_milestone" }, value: { status: "merged", value: 8 } } });
    expect(result.ranking).toEqual(classifyStewardshipAssessmentAgreement(value.assessments[0].envelope.assessment,
      value.assessments[1].envelope.assessment).ranking);
    for (const entry of value.assessments) {
      const decoded = stewardshipAssessmentEnvelopeSchema.parse(JSON.parse(JSON.stringify(entry.envelope)));
      expect(canonicalJsonSha256(decoded)).toBe(entry.sha256);
      expect(decoded.schemaVersion).toBe("github-issue-roadmap-stewardship-assessment/v2");
    }
  });
  it.each([
    ["completion", "already_complete_requires_lifecycle_review"], ["premise", "premise_requires_rescoping"],
    ["choice", "unresolved_product_choice"],
  ] as const)("preserves %s escalation, even with abstention", (signal, reason) => {
    const value = structuredClone(currentInput()); const assessment = stewardshipAssessmentSchema.parse(value.assessments[1].envelope.assessment);
    assessment.ranking.tier = { status: "abstain", reason: "Evidence missing." };
    if (signal === "completion") assessment.completion = "complete";
    else if (signal === "premise") assessment.premise = "disproved";
    else assessment.unresolvedChoices = ["Choose the product contract"];
    value.assessments[1] = freezeStewardshipAssessment({ ...value, assessment, seat: value.assessments[1].envelope.seat, assessedAt: now });
    expect(compileStewardshipDecision(value)).toMatchObject({ compilerVersion: 4, status: "escalated", reasons: [reason], operations: [], comments: [] });
  });
  it("refuses a schema-invalid seat without a partial ranking", () => {
    const value = structuredClone(currentInput());
    const assessment = value.assessments[1].envelope.assessment;
    if (!("ranking" in assessment)) throw new Error("Expected ranking fixture");
    assessment.ranking.value = { status: "assessed", value: 11, rationale: "Invalid score." };
    value.assessments[1] = { ...value.assessments[1], sha256: canonicalJsonSha256(value.assessments[1].envelope) };
    const result = compileStewardshipDecision(value);
    expect(result).toMatchObject({ compilerVersion: 4, status: "deferred", operations: [], reasons: ["invalid_bound_assessment_or_evidence"] });
    expect(result).not.toHaveProperty("ranking");
  });
  it("defers mixed contract versions without entering the legacy write path", () => {
    const value = currentInput(); value.assessments[1] = input().assessments[1];
    expect(compileStewardshipDecision(value)).toMatchObject({ compilerVersion: 4, status: "deferred", operations: [], reasons: ["incompatible_assessment_versions"] });
  });
});

function input(evidence = evidenceFixture(), edit: (value: StewardshipAssessment) => void = () => {}, editRight: (value: StewardshipAssessment) => void = () => {}) {
  const assessment = assessmentFixture(evidence); edit(assessment);
  const assessments = (["anthropic", "glm"] as const).map((family) => {
    const value = structuredClone(assessment); if (family === "glm") editRight(value);
    return freezeStewardshipAssessment({ evidence, policy, assessment: value,
      seat: { family, requestedModel: family === "glm" ? "glm-5.3" : "opus", observedModel: "unknown" }, assessedAt: now });
  });
  return { evidence, policy, assessments, now, census: { complete: true, nowCount: 0 } };
}
function currentFields(Priority: "P0" | "P1" | "P2" | "P3" | null, Horizon: "Now" | "Next" | "Later" | "Parked" | null = "Later") {
  const evidence = evidenceFixture();
  return rebind({ ...evidence, packet: { ...evidence.packet, fields: { Priority, Horizon }, issue: { ...evidence.packet.issue,
    v1: { ...evidence.packet.issue.v1, fieldValues: (["Priority", "Horizon"] as const).flatMap((name) => {
      const value = name === "Priority" ? Priority : Horizon;
      return value === null ? [] : [{ name: value, value, field: { name } }];
    }) } } } });
}
function nowAssessment(value: StewardshipAssessment) { value.proposed.Horizon = "Now"; value.sequencing.disposition = "now"; }
describe("stewardship deterministic compiler", () => {
  it("records current P2/Later agreement with choices and exactly three differing clause statuses", () => {
    const base = evidenceFixture();
    const evidence = rebind({ ...base, packet: { ...base.packet, clauses: Array.from({ length: 11 }, (_, index) => ({
      ...base.packet.clauses[0], clauseId: `clause:1:${index + 1}`,
    })) } });
    const differingIds = ["clause:1:2", "clause:1:5", "clause:1:9"];
    const decision = compileStewardshipDecision(input(evidence, (value) => {
      value.proposed.Priority = "P2"; value.unresolvedChoices = ["Choose the output contract"];
      value.clauses = evidence.packet.clauses.map(({ clauseId }) => ({ ...value.clauses[0], clauseId }));
    }, (value) => {
      value.unresolvedChoices = ["Choose the consumer contract", "Choose the migration order"];
      for (const clause of value.clauses) if (differingIds.includes(clause.clauseId)) clause.status = "fulfilled";
    }));
    expect(decision.status).toBe("no-change"); expect(decision.operations).toEqual([]);
    expect(decision.divergence).toEqual({ differingKeys: ["clauseStatuses", "unresolvedChoices"], clauseIds: differingIds });
  });
  it("escalates a P2 versus P3 proposal split", () => {
    const decision = compileStewardshipDecision(input(evidenceFixture(), () => {}, (value) => { value.proposed.Priority = "P2"; }));
    expect(decision.status).toBe("escalated"); expect(decision.reasons).toEqual(["independent_assessments_disagree"]);
    expect(decision.operations).toEqual([]); expect(decision.divergence).toBeNull();
  });
  it("escalates an unresolved choice on either seat for an otherwise agreed P2 to P3 change", () => {
    const decision = compileStewardshipDecision(input(evidenceFixture(), () => {}, (value) => { value.unresolvedChoices = ["Choose the output contract"]; }));
    expect(decision.status).toBe("escalated"); expect(decision.reasons).toEqual(["unresolved_product_choice"]);
    expect(decision.operations).toEqual([]); expect(decision.divergence).toBeNull();
  });
  it.each([
    ["completion", "already_complete_requires_lifecycle_review"], ["premise", "premise_requires_rescoping"],
  ] as const)("escalates when only the right seat reports lifecycle risk in %s", (field, reason) => {
    const decision = compileStewardshipDecision(input(evidenceFixture(), (value) => { value.proposed.Priority = "P2"; }, (value) => {
      if (field === "completion") value.completion = "complete"; else value.premise = "disproved";
    }));
    expect(decision.status).toBe("escalated"); expect(decision.reasons).toEqual([reason]); expect(decision.operations).toEqual([]);
  });
  it.each(["Now", "Next"] as const)("keeps current %s no-change proposals on the strict clause-status path", (horizon) => {
    const evidence = currentFields("P2", horizon);
    const decision = compileStewardshipDecision(input(evidence, (value) => { value.proposed = { ...evidence.packet.fields }; }, (value) => {
      value.clauses[0].status = "fulfilled";
    }));
    expect(decision.status).toBe("escalated"); expect(decision.reasons).toEqual(["independent_assessments_disagree"]);
  });
  it.each([
    ["Now", "Later"], ["Next", "Later"],
  ] as const)("keeps a P2/%s departure to P2/%s on the strict agreement path", (current, proposed) => {
    const decision = compileStewardshipDecision(input(currentFields("P2", current), (value) => {
      value.proposed = { Priority: "P2", Horizon: proposed };
      value.sequencing.disposition = current === "Now" ? "now" : "after_current";
    }, (value) => {
      value.clauses[0].status = "fulfilled"; value.sequencing.disposition = "unknown";
    }));
    expect(decision.status).toBe("escalated"); expect(decision.reasons).toEqual(["independent_assessments_disagree"]);
    expect(decision.operations).toEqual([]);
  });
  it.each(["Now target", "P1 demotion"])("keeps a %s on the strict clause-status path", (boundary) => {
    const evidence = currentFields(boundary === "P1 demotion" ? "P1" : "P2");
    const decision = compileStewardshipDecision(input(evidence, (value) => {
      if (boundary === "Now target") nowAssessment(value);
      else {
        value.demotion = { kind: "stronger_current_evidence", statement: "The closeable gap has low impact.", evidenceIds: value.evidenceIds };
        value.counterevidenceIds = value.evidenceIds;
      }
    }, (value) => { value.clauses[0].status = "fulfilled"; }));
    expect(decision.status).toBe("escalated"); expect(decision.operations).toEqual([]);
    expect(decision.reasons).toEqual(["independent_assessments_disagree"]);
  });
  it("a hold refuses downgraded clause agreement and produces no supersession", () => {
    const value = input(evidenceFixture(), () => {}, (assessment) => { assessment.clauses[0].status = "fulfilled"; });
    const hold: StewardshipHold = { kind: "operator", value: "P2", frontier: value.evidence.packet.fieldHistory.Priority.frontier,
      at: "2026-09-22T12:00:00Z", materialEvidenceSha256: value.evidence.packet.materialEvidenceSha256 };
    const decision = compileStewardshipDecision({ ...value, holds: { Priority: hold } });
    expect(decision.status).toBe("escalated"); expect(decision.reasons).toEqual(["independent_assessments_disagree"]);
    expect(decision.operations).toEqual([]); expect(decision.holdSupersessions).toEqual([]);
  });
  it("records uncertain premise or completion as a concern on current-value agreement", () => {
    for (const field of ["premise", "completion"] as const) {
      const decision = compileStewardshipDecision(input(evidenceFixture(), (value) => { value.proposed.Priority = "P2"; }, (value) => { value[field] = "uncertain"; }));
      expect(decision.status).toBe("no-change"); expect(decision.reasons).toEqual(["stable_material_decision", "concern_incomplete_premise_or_completion_evidence"]);
      expect(decision.divergence).toEqual({ differingKeys: [field], clauseIds: [] });
      expect(decision.operations).toEqual([]); expect(decision.comments).toEqual([]);
    }
  });
  it("records sorted concern keys without model text on an ordinary no-change", () => {
    const privateText = "private-model-choice-text";
    const decision = compileStewardshipDecision(input(evidenceFixture(), (value) => { value.proposed.Priority = "P2"; }, (value) => {
      value.unresolvedChoices = [privateText]; value.independentlyCloseable = false; value.blockers = [4, 2];
      value.rubricFacts.worthwhile = null; value.sequencing.statement = privateText;
      value.demotion = { kind: "stronger_current_evidence", statement: privateText, evidenceIds: value.evidenceIds };
      value.revisitTrigger = { statement: privateText, evidenceIds: value.evidenceIds };
    }));
    expect(decision.status).toBe("no-change"); expect(decision.operations).toEqual([]);
    expect(decision.divergence).toEqual({ differingKeys: ["blockers", "demotion", "independentlyCloseable", "revisitTrigger", "rubricFacts", "unresolvedChoices"], clauseIds: [] });
    expect(JSON.stringify(decision.divergence)).not.toContain(privateText);
  });
  it("records identical unresolved choices as concerns on current P2/Later agreement", () => {
    const decision = compileStewardshipDecision(input(currentFields("P2", "Later"), (value) => {
      value.proposed = { Priority: "P2", Horizon: "Later" }; value.unresolvedChoices = ["Choose the output contract"];
    }));
    expect(decision.status).toBe("no-change"); expect(decision.operations).toEqual([]);
    expect(decision.divergence).toEqual({ differingKeys: ["unresolvedChoices"], clauseIds: [] });
    expect(decision.reasons).toEqual(["stable_material_decision", "concern_unresolved_product_choice"]);
  });
  it("records one seat's unresolved choice as a concern on current-value agreement", () => {
    const decision = compileStewardshipDecision(input(currentFields("P3", "Later"), (value) => {
      value.proposed = { Priority: "P3", Horizon: "Later" };
    }, (value) => { value.unresolvedChoices = ["Choose the billing model"]; }));
    expect(decision.status).toBe("no-change"); expect(decision.operations).toEqual([]);
    expect(decision.reasons).toEqual(["stable_material_decision", "concern_unresolved_product_choice"]);
  });
  it.each(["sequencing", "rubricFacts", "demotion", "revisitTrigger"] as const)("ignores a statement-only %s difference on agreeing outcomes", (field) => {
    for (const priority of ["P2", "P3"] as const) {
      const decision = compileStewardshipDecision(input(evidenceFixture(), (value) => {
        value.proposed.Priority = priority;
        value.demotion = { kind: "stronger_current_evidence", statement: "A closeable gap remains.", evidenceIds: value.evidenceIds };
        value.revisitTrigger = { statement: "Review when the cited condition changes.", evidenceIds: value.evidenceIds };
      }, (value) => {
        if (field === "rubricFacts") value.rubricFacts.worthwhile!.statement = "Alternate wording for the same facts.";
        else value[field]!.statement = "Alternate wording for the same facts.";
      }));
      expect(decision.status).toBe(priority === "P2" ? "no-change" : "eligible");
      expect(decision.divergence?.differingKeys ?? []).not.toContain(field);
      expect(decision.divergence).toBeNull();
    }
  });
  it("records incomplete coverage and missing required rubric facts as current-value concerns", () => {
    const base = evidenceFixture();
    const incomplete = rebind({ ...base, packet: { ...base.packet, coverage: { ...base.packet.coverage, sourceComplete: false } } });
    const coverage = compileStewardshipDecision(input(incomplete, (value) => { value.proposed.Priority = "P2"; }));
    expect(coverage.status).toBe("no-change"); expect(coverage.reasons).toEqual(["stable_material_decision", "concern_incomplete_evidence_coverage"]);
    expect(coverage.operations).toEqual([]);
    const rubric = compileStewardshipDecision(input(base, (value) => { value.proposed.Priority = "P2"; }, (value) => { value.rubricFacts.remainingGap = null; }));
    expect(rubric.status).toBe("no-change"); expect(rubric.reasons).toEqual(["stable_material_decision", "concern_priority_rubric_not_proven"]);
    expect(rubric.operations).toEqual([]); expect(rubric.divergence).toEqual({ differingKeys: ["rubricFacts"], clauseIds: [] });
  });
  it("records thin-evidence current P3/Parked agreement with ordered concerns and no writes", () => {
    const base = currentFields("P3", "Parked");
    const evidence = rebind({ ...base, packet: { ...base.packet, coverage: { ...base.packet.coverage, sourceComplete: false } } });
    const decision = compileStewardshipDecision(input(evidence, (value) => {
      value.proposed = { ...evidence.packet.fields }; value.premise = "uncertain"; value.revisitTrigger = null;
    }));
    expect(decision.status).toBe("no-change");
    expect(decision.reasons).toEqual(["stable_material_decision", "concern_incomplete_premise_or_completion_evidence",
      "concern_incomplete_evidence_coverage", "concern_parked_without_named_trigger"]);
    expect(decision.operations).toEqual([]); expect(decision.comments).toEqual([]);
  });
  it.each(["Now", "Next"] as const)("keeps incomplete current %s agreement on the strict coverage path", (horizon) => {
    const base = currentFields("P2", horizon);
    const evidence = rebind({ ...base, packet: { ...base.packet, coverage: { ...base.packet.coverage, sourceComplete: false } } });
    const decision = compileStewardshipDecision(input(evidence, (value) => { value.proposed = { ...evidence.packet.fields }; }));
    expect(decision.status).toBe("deferred"); expect(decision.reasons).toEqual(["incomplete_evidence_coverage"]);
    expect(decision.operations).toEqual([]);
  });
  it("keeps held current-value agreement on the strict coverage path", () => {
    const base = currentFields("P2");
    const evidence = rebind({ ...base, packet: { ...base.packet, coverage: { ...base.packet.coverage, sourceComplete: false } } });
    const hold: StewardshipHold = { kind: "operator", value: "P2", frontier: evidence.packet.fieldHistory.Priority.frontier,
      at: "2026-09-22T12:00:00Z", materialEvidenceSha256: evidence.packet.materialEvidenceSha256 };
    const decision = compileStewardshipDecision({ ...input(evidence, (value) => { value.proposed = { ...evidence.packet.fields }; }), holds: { Priority: hold } });
    expect(decision.status).toBe("deferred"); expect(decision.reasons).toEqual(["incomplete_evidence_coverage"]);
    expect(decision.operations).toEqual([]);
  });
  it("defers non-open current-value agreement", () => {
    const base = currentFields("P2");
    const evidence = rebind({ ...base, packet: { ...base.packet, issue: { ...base.packet.issue, v1: { ...base.packet.issue.v1, state: "CLOSED" } } } });
    const decision = compileStewardshipDecision(input(evidence, (value) => { value.proposed = { ...evidence.packet.fields }; }));
    expect(decision.status).toBe("deferred"); expect(decision.reasons).toEqual(["issue_not_open"]);
    expect(decision.operations).toEqual([]);
  });
  // Production replay cases are excluded from this public source copy.
  it("records sorted compiler seat provenance regardless of assessment order", () => {
    const value = input();
    const decision = compileStewardshipDecision({ ...value, assessments: [...value.assessments].reverse() });
    expect(decision).toMatchObject({ compilerVersion: 3, seatFamilies: ["anthropic", "glm"] });
  });
  it("admits ordinary Priority agreement with independently valid alternate support and irrelevant slots", () => {
    const value = structuredClone(input()); const right = value.assessments[1].envelope.assessment;
    right.rubricFacts.worthwhile!.evidenceIds = [value.evidence.packet.facts[0].factId];
    right.rubricFacts.remainingGap = null; right.sequencing.disposition = "unknown";
    value.assessments[1] = { ...value.assessments[1], sha256: canonicalJsonSha256(value.assessments[1].envelope) };
    const decision = compileStewardshipDecision(value);
    expect(decision.operations).toEqual([{ kind: "set_priority", value: "P3" }]);
    expect(decision.divergence).toEqual({ differingKeys: ["rubricFacts", "sequencing"], clauseIds: [] });
  });
  it.each(["P0", "P1", "Now", "Next", "Parked", "hold", "supersession"])("retains strict support agreement for %s", (boundary) => {
    const evidence = currentFields(boundary === "P0" || boundary === "P1" ? boundary : "P2",
      boundary === "Now" || boundary === "Next" || boundary === "Parked" ? boundary : "Later");
    const value = structuredClone(input(evidence));
    for (const entry of value.assessments) {
      entry.envelope.assessment.proposed.Horizon = evidence.packet.fields.Horizon;
      if (boundary === "supersession") entry.envelope.assessment.supersedesHold = { previousEvidenceSha256s: ["a".repeat(64)], changedFactIds: [evidence.packet.facts[0].factId], statement: "A changed fact." };
    }
    const right = value.assessments[1].envelope.assessment;
    right.rubricFacts.worthwhile = { ...right.rubricFacts.worthwhile!, evidenceIds: [evidence.packet.facts[0].factId] };
    value.assessments = value.assessments.map((entry) => ({ ...entry, sha256: canonicalJsonSha256(entry.envelope) }));
    const holds = boundary === "hold" ? { Priority: { kind: "operator" as const, value: "P2" as const, frontier: evidence.packet.fieldHistory.Priority.frontier,
      at: now, materialEvidenceSha256: evidence.packet.materialEvidenceSha256 } } : undefined;
    const result = compileStewardshipDecision({ ...value, holds });
    expect(result.status).toBe("escalated"); expect(result.reasons).toContain("independent_assessments_disagree"); expect(result.operations).toEqual([]);
  });
  it("uses required rubric-fact presence for an ordinary unset Priority transition", () => {
    const evidence = currentFields(null);
    const decision = compileStewardshipDecision(input(evidence, () => {}, (value) => {
      value.rubricFacts.worthwhile!.evidenceIds = [evidence.packet.facts[0].factId];
    }));
    expect(decision.status).toBe("eligible"); expect(decision.operations).toEqual([{ kind: "set_priority", value: "P3" }]);
    expect(decision.divergence).toEqual({ differingKeys: ["rubricFacts"], clauseIds: [] });
  });
  it.each([
    ["Priority", "codex"], ["Priority", "glm"], ["Priority", "both"],
    ["Horizon", "codex"], ["Horizon", "glm"], ["Horizon", "both"],
  ] as const)("defers the whole issue for %s abstention by %s, including unset Horizon", (field, abstainingSeat) => {
    for (const horizon of ["Later", null] as const) {
      const evidence = currentFields("P2", horizon); const fields = structuredClone(evidence.packet.fields);
      const assessments = (["codex", "glm"] as const).map((family) => {
        const assessment = assessmentFixture(evidence);
        assessment.proposed = { Priority: "P3", Horizon: "Later" };
        if (abstainingSeat === "both" || abstainingSeat === family) assessment.proposed[field] = null;
        return freezeStewardshipAssessment({ evidence, policy, assessment, assessedAt: now,
          seat: { family, requestedModel: family === "codex" ? "gpt-6-astra" : "glm-5.3", observedModel: "fixture" } });
      });
      const decision = compileStewardshipDecision({ evidence, policy, assessments, now, census: { complete: true, nowCount: 0 } });
      expect(decision).toMatchObject({ status: "deferred", reasons: ["needs_evidence"],
        operations: [], comments: [], holdSupersessions: [], divergence: null });
      expect(evidence.packet.fields).toEqual(fields);
    }
  });
  it("defers both seats' fully null proposals when neither field is set", () => {
    const evidence = currentFields(null, null);
    const decision = compileStewardshipDecision(input(evidence, (value) => { value.proposed = { Priority: null, Horizon: null }; }));
    expect(decision).toMatchObject({ status: "deferred", reasons: ["needs_evidence"], operations: [], comments: [] });
    expect(evidence.packet.fields).toEqual({ Priority: null, Horizon: null });
  });
  it("independently refuses absent citations and missing required rubric facts in the ordinary path", () => {
    for (const failure of ["citation", "one_missing", "both_missing"]) {
      const value = structuredClone(input());
      const right = value.assessments[1].envelope.assessment;
      if (failure === "citation") right.rubricFacts.worthwhile = { ...right.rubricFacts.worthwhile!, evidenceIds: ["invented"] };
      else right.rubricFacts.worthwhile = null;
      if (failure === "both_missing") value.assessments[0].envelope.assessment.rubricFacts.worthwhile = null;
      value.assessments = value.assessments.map((entry) => ({ ...entry, sha256: canonicalJsonSha256(entry.envelope) }));
      const result = compileStewardshipDecision(value);
      expect(result.operations).toEqual([]);
      if (failure === "both_missing") expect(result.reasons).toContain("priority_rubric_not_proven");
      if (failure === "one_missing") expect(result.reasons).toContain("independent_assessments_disagree");
    }
  });
  it.each([
    ["premise", "premise_requires_rescoping"], ["completion", "already_complete_requires_lifecycle_review"],
    ["blocker", "independent_assessments_disagree"], ["choice", "unresolved_product_choice"],
  ])("keeps ordinary Priority disagreement on %s protected", (field, reason) => {
    const value = structuredClone(input()); const right = value.assessments[1].envelope.assessment;
    if (field === "premise") right.premise = "disproved";
    if (field === "completion") right.completion = "complete";
    if (field === "blocker") right.blockers = [2];
    if (field === "choice") right.unresolvedChoices = ["Choose the contract"];
    value.assessments[1] = { ...value.assessments[1], sha256: canonicalJsonSha256(value.assessments[1].envelope) };
    expect(compileStewardshipDecision(value).reasons).toContain(reason);
  });
  it("records ordinary agreed-change clause-status differences without escalating", () => {
    const decision = compileStewardshipDecision(input(evidenceFixture(), () => {}, (value) => { value.clauses[0].status = "fulfilled"; }));
    expect(decision.status).toBe("eligible"); expect(decision.operations).toEqual([{ kind: "set_priority", value: "P3" }]);
    expect(decision.divergence).toEqual({ differingKeys: ["clauseStatuses"], clauseIds: ["clause:1:1"] });
  });
  it("admits a routine P2 to P3 change from both bound model families", () => {
    const decision = compileStewardshipDecision(input());
    expect(decision.status).toBe("eligible");
    expect(decision.operations).toEqual([{ kind: "set_priority", value: "P3" }]);
    expect(decision.divergence).toBeNull();
  });
  it("keeps the whole issue unchanged when fields or eligibility facts disagree", () => {
    for (const mutate of [(value: ReturnType<typeof input>) => { value.assessments[1].envelope.assessment.proposed.Horizon = "Next"; },
      (value: ReturnType<typeof input>) => { value.assessments[1].envelope.assessment.independentlyCloseable = false; }]) {
      const value = structuredClone(input()); mutate(value);
      value.assessments[1] = { ...value.assessments[1], sha256: canonicalJsonSha256(value.assessments[1].envelope) };
      const decision = compileStewardshipDecision(value);
      expect(decision.operations).toEqual([]); expect(decision.status).toBe("escalated");
    }
  });
  it("refuses unproven code, sensitive demotion, stale bindings and same-family assessments", () => {
    const value = structuredClone(input());
    value.assessments[1].envelope.seat.family = "anthropic";
    value.assessments[1] = { ...value.assessments[1], sha256: canonicalJsonSha256(value.assessments[1].envelope) };
    expect(compileStewardshipDecision(value).operations).toEqual([]);
    const missing = input(); missing.assessments.pop();
    expect(compileStewardshipDecision(missing).operations).toEqual([]);
  });
  it.each(["P0", "P1"] as const)("requires every %s rubric claim and direct current evidence", (priority) => {
    const rejected = compileStewardshipDecision(input(evidenceFixture(), (value) => { value.proposed.Priority = priority; }));
    expect(rejected.operations).toEqual([]); expect(rejected.reasons).toContain("priority_rubric_not_proven");
    const accepted = compileStewardshipDecision(input(evidenceFixture(), (value) => {
      value.proposed.Priority = priority;
      for (const key of Object.keys(value.rubricFacts) as (keyof StewardshipAssessment["rubricFacts"])[]) value.rubricFacts[key] = value.rubricFacts.impact;
    }));
    expect(accepted.status).toBe("eligible"); expect(accepted.operations).toContainEqual({ kind: "set_priority", value: priority });
  });
  it.each(["P0", "P1"] as const)("blocks %s demotion without cited current counterevidence", (priority) => {
    const evidence = currentFields(priority);
    expect(compileStewardshipDecision(input(evidence)).reasons).toContain("sensitive_demotion_requires_counterevidence");
    const accepted = compileStewardshipDecision(input(evidence, (value) => {
      value.demotion = { kind: "stronger_current_evidence", statement: "The current path only returns null and the closeable gap has low impact.", evidenceIds: value.evidenceIds };
      value.counterevidenceIds = value.evidenceIds;
    }));
    expect(accepted.status).toBe("eligible");
  });
  it("requires a named Parked trigger and treats null Priority as abstention", () => {
    expect(compileStewardshipDecision(input(evidenceFixture(), (value) => { value.proposed.Priority = null; }))).toMatchObject({
      status: "deferred", reasons: ["needs_evidence"], operations: [],
    });
    expect(compileStewardshipDecision(input(evidenceFixture(), (value) => { value.proposed.Horizon = "Parked"; })).reasons).toContain("parked_requires_named_trigger");
    const accepted = compileStewardshipDecision(input(evidenceFixture(), (value) => {
      value.proposed.Horizon = "Parked"; value.sequencing.disposition = "trigger";
      value.revisitTrigger = { statement: "Revisit when the bounded-result API ships.", evidenceIds: value.evidenceIds };
    }));
    expect(accepted.operations).toContainEqual({ kind: "set_horizon", value: "Parked" });
  });
  it("Now emits a parser-trusted verification with immutable main, evidence, clause and assessment bindings", () => {
    const value = input(evidenceFixture(), nowAssessment);
    const result = compileStewardshipDecision(value);
    expect(result.status).toBe("eligible");
    const comment = result.comments.find((entry) => entry.purpose === "verification")!;
    expect(comment.body).toContain(value.evidence.originMainSha); expect(comment.body).toContain(value.evidence.packet.materialEvidenceSha256);
    for (const assessment of value.assessments) expect(comment.body).toContain(assessment.sha256);
    const records = parsePersistedVerificationRecords({ trustedAuthors: ["trusted-bot"], body: null, issueAuthor: null,
      issueCreatedAt: now, issueUpdatedAt: now, comments: [{ id: 1, node_id: "C_1", user: { login: "trusted-bot" }, body: comment.body, created_at: now, updated_at: now }] });
    expect(records[0].trust.status).toBe("trusted"); expect(records[0].originMainSha).toBe(value.evidence.originMainSha);
    expect(result.operations.at(-1)).toEqual({ kind: "set_horizon", value: "Now" });
  });
  it.each([
    ["missing code proof", (value: StewardshipAssessment) => { value.clauses[0].codeReferences = []; }, "clause_level_code_proof_required"],
    ["blocker", (value: StewardshipAssessment) => { value.blockers = [2]; }, "execution_prerequisites_unmet"],
    ["choice", (value: StewardshipAssessment) => { value.unresolvedChoices = ["Choose output contract"]; }, "unresolved_product_choice"],
    ["completed", (value: StewardshipAssessment) => { value.completion = "complete"; }, "already_complete_requires_lifecycle_review"],
    ["no sequencing", (value: StewardshipAssessment) => { value.sequencing.disposition = "unknown"; }, "explicit_sequencing_required"],
    ["umbrella", (value: StewardshipAssessment) => { value.independentlyCloseable = false; }, "execution_prerequisites_unmet"],
  ] as const)("Now refuses %s", (_name, edit, reason) => {
    const decision = compileStewardshipDecision(input(evidenceFixture(), (value) => { nowAssessment(value); edit(value); }));
    expect(decision.operations).toEqual([]); expect(decision.reasons).toContain(reason);
  });
  it("uses the complete live Now census and never frees a pending demotion slot", () => {
    for (const census of [{ complete: false, nowCount: 0 }, { complete: true, nowCount: 3 }, { complete: true, nowCount: 5 }]) {
      expect(compileStewardshipDecision({ ...input(evidenceFixture(), nowAssessment), census }).reasons).toContain("now_capacity_unavailable");
    }
    expect(compileStewardshipDecision({ ...input(evidenceFixture(), nowAssessment), census: { complete: true, nowCount: 2 } }).status).toBe("eligible");
  });
  it("Next requires code proof and deliberate sequencing but no Now capacity", () => {
    const decision = compileStewardshipDecision({ ...input(evidenceFixture(), (value) => { value.proposed.Horizon = "Next"; value.sequencing.disposition = "after_current"; }), census: { complete: true, nowCount: 20 } });
    expect(decision.status).toBe("eligible");
  });
  it("reuses the same material assessment without inventing a new verification timestamp", () => {
    const value = input(evidenceFixture(), nowAssessment);
    const nextDay = compileStewardshipDecision({ ...value, now: "2026-09-24T12:00:00Z" });
    expect(nextDay.comments[0].body).toContain(`verified-at: ${now}`);
    expect(compileStewardshipDecision({ ...value, now: "2026-10-23T12:00:00Z" }).reasons).toContain("code_inspection_requires_refresh");
  });
  it("pins, provenance and missing contemporaneous hold evidence always protect the issue", () => {
    for (const kind of ["pin", "provenance", "operator"] as const) {
      const value = input(); const hold: StewardshipHold = { kind, value: "Later", frontier: value.evidence.packet.fieldHistory.Horizon.frontier,
        materialEvidenceSha256: value.evidence.packet.materialEvidenceSha256, at: "2026-09-22T12:00:00Z" };
      const result = compileStewardshipDecision({ ...value, holds: { Horizon: hold } });
      expect(result.operations).toEqual([]); expect(result.reasons).toContain(`horizon_${kind}_hold`);
    }
  });
  it("lapses an operator hold only for cited changed visible facts assessed after the intervention", () => {
    const evidence = evidenceFixture(); const oldSource = evidence.packet.sources[0];
    const oldText = "export function current() { throw new Error('old failure'); }\n";
    const oldHash = sha256Bytes(oldText);
    const previous = rebind({ ...evidence, originMainSha: "b".repeat(40), packet: { ...evidence.packet,
      sources: [{ ...oldSource, evidenceId: `source:${oldHash}`, contentSha256: oldHash, snippetSha256: oldHash, text: oldText, byteLength: Buffer.byteLength(oldText), fullByteLength: Buffer.byteLength(oldText) }],
      clauses: [{ ...evidence.packet.clauses[0], evidenceIds: [`source:${oldHash}`] }],
      facts: [{ ...evidence.packet.facts[0], contentSha256: canonicalJsonSha256({ path: oldSource.path, contentSha256: oldHash }), evidenceIds: [`source:${oldHash}`] }] } });
    const hold: StewardshipHold = { kind: "operator", value: "P2", frontier: evidence.packet.fieldHistory.Priority.frontier,
      materialEvidenceSha256: previous.packet.materialEvidenceSha256, at: "2026-09-22T12:00:00Z" };
    const value = input(evidence, (assessment) => { assessment.supersedesHold = {
      previousEvidenceSha256s: [hold.materialEvidenceSha256], changedFactIds: [evidence.packet.facts[0].factId], statement: "The old throw is gone; the residual null return supports P3." }; });
    const options = { ...value, holds: { Priority: hold }, heldEvidence: { [hold.materialEvidenceSha256]: previous } };
    expect(compileStewardshipDecision(options).holdSupersessions).toHaveLength(1);
    const disagreement = structuredClone(options);
    disagreement.assessments[1].envelope.assessment.clauses[0].status = "fulfilled";
    disagreement.assessments[1] = { ...disagreement.assessments[1], sha256: canonicalJsonSha256(disagreement.assessments[1].envelope) };
    const refused = compileStewardshipDecision(disagreement);
    expect(refused.status).toBe("escalated"); expect(refused.reasons).toEqual(["independent_assessments_disagree"]);
    expect(refused.holdSupersessions).toEqual([]); expect(refused.operations).toEqual([]);
    const unrelated = rebind({ ...evidence, originMainSha: "c".repeat(40) });
    const unchangedHold = { ...hold, materialEvidenceSha256: unrelated.packet.materialEvidenceSha256 };
    expect(compileStewardshipDecision({ ...options, holds: { Priority: unchangedHold }, heldEvidence: { [unchangedHold.materialEvidenceSha256]: unrelated } }).operations).toEqual([]);
    expect(compileStewardshipDecision({ ...options, holds: { Priority: { ...hold, at: now } } }).operations).toEqual([]);
  });
});
