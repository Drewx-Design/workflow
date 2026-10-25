import { describe, expect, it, vi } from "vitest";
import { stewardshipPhaseBTrigger } from "../lib/github-issue-roadmap/stewardship-assessment";
import { assessStewardshipIssue, classifyStewardshipAssessmentAgreement, stewardshipAssessmentSchema, STEWARDSHIP_ASTRA_ASSESSMENT_PROTOCOL, STEWARDSHIP_SEAT_STARTUP_MS, freezeStewardshipAssessment, stewardshipAssessmentEnvelopeSchema, validateStewardshipAssessment, type StewardshipSeat } from "../lib/github-issue-roadmap/stewardship-assessment";
import { canonicalJsonSha256, sha256Bytes } from "../lib/github-issue-roadmap/canonical-json";
import { assessmentFixture as legacyAssessmentFixture, evidenceFixture, now, policy, rebind } from "./fixtures/roadmap-stewardship";
import { knownStewardshipPolicy, stewardshipPolicySha256 } from "../lib/github-issue-roadmap/stewardship-policy";
import { compileStewardshipDecision } from "../lib/github-issue-roadmap/stewardship-decision";
import { createClaudeGlmStewardshipSeats } from "../lib/github-issue-roadmap/stewardship-seats";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import { runTestRoadmapSort as runRoadmapSort, acquireTestStewardshipStore as acquireStewardshipStore } from "./roadmap-test-host-lock";
import { stewardshipPaths, readStewardshipState, setStewardshipPaused, StewardshipReservationRefusal, stewardshipEventSchema } from "../lib/github-issue-roadmap/stewardship-state";
import { StewardshipAssessmentError } from "../lib/github-issue-roadmap/stewardship-diagnostics";

type SeatInput = Parameters<StewardshipSeat["invoke"]>[0];

function rankingFixture() {
  return stewardshipAssessmentSchema.shape.ranking.parse({
    lane: { status: "assessed", value: "product", rationale: "Customer output." },
    tier: { status: "assessed", value: "blocks_milestone", rationale: "Generation cannot finish." },
    milestoneStep: { status: "assessed", value: 6, rationale: "Generate." },
    value: { status: "assessed", value: 8, rationale: "Blocks the first LOI." },
    effort: { status: "assessed", value: "low", rationale: "One small change." },
    severity: { status: "assessed", value: "P1", rationale: "Core flow broken." },
    doneStale: { status: "assessed", value: "no", rationale: "Gap remains." },
  });
}
function assessmentFixture(evidence = evidenceFixture()) {
  const { proposed: _proposed, ...legacy } = legacyAssessmentFixture(evidence);
  void _proposed;
  return stewardshipAssessmentSchema.parse({ ...legacy, binding: { ...legacy.binding, rubric: "roadmap-backlog-ranking/v1" },
    ranking: { ...rankingFixture(), tier: { status: "assessed", value: "v1_not_blocking", rationale: "In scope." },
      severity: { status: "assessed", value: "none", rationale: "Feature." } }, codeNeeded: [] });
}
/** Drives the merge table through its only production caller. */
function merge(left: ReturnType<typeof rankingFixture>, right: ReturnType<typeof rankingFixture>) {
  const ranking = classifyStewardshipAssessmentAgreement({ ...assessmentFixture(), ranking: left }, { ...assessmentFixture(), ranking: right }).ranking;
  if (!ranking) throw new Error("Expected a merged ranking");
  return ranking;
}

describe("KTD4 Phase B trigger table", () => {
  it.each([
    ["tier abstained", "abstain", "low", "none", [], {}, ["tier_needs_evidence"]],
    ["code requested", "v1_not_blocking", "low", "none", ["effort"], {}, ["code_needed"]],
    ["milestone blocker", "blocks_milestone", "low", "none", [], {}, ["blocks_milestone"]],
    ["possible defect", "v1_not_blocking", "low", "P1", [], {}, ["defect_severity"]],
    ["blocker effort split", "blocks_milestone", "high", "none", [], {}, ["blocks_milestone", "effort_unmerged"]],
    ["top candidate effort split", "v1_not_blocking", "high", "none", [], { topFormulaCandidate: true }, ["effort_unmerged"]],
    ["ordinary effort split", "v1_not_blocking", "high", "none", [], {}, []],
    ["ordinary agreement", "v1_not_blocking", "low", "none", [], {}, []],
    ["Now lacks Phase B", "v1_not_blocking", "low", "none", [], { nowCandidate: true }, ["now_without_phase_b"]],
    ["Now has Phase B", "v1_not_blocking", "low", "none", [], { nowCandidate: true, currentPhaseB: true }, []],
  ] as const)("%s", (_name, tier, effort, severity, codeNeeded, context, triggers) => {
    const left = assessmentFixture(); const right = assessmentFixture();
    for (const seat of [left, right]) {
      seat.ranking.tier = tier === "abstain" ? { status: "abstain", reason: "Need code." } : { status: "assessed", value: tier, rationale: "Scope." };
      seat.ranking.severity = { status: "assessed", value: "none", rationale: "Feature." };
    }
    right.ranking.effort = { status: "assessed", value: effort, rationale: "Size." };
    right.ranking.severity = { status: "assessed", value: severity, rationale: "Impact." };
    right.codeNeeded = [...codeNeeded];
    const agreement = classifyStewardshipAssessmentAgreement(left, right);
    expect(agreement.ranking?.codeNeeded.seats).toEqual([[], codeNeeded]);
    expect(stewardshipPhaseBTrigger(agreement, [left.codeNeeded, right.codeNeeded], context)).toEqual({ required: triggers.length > 0, triggers });
  });
  it("requests Phase B when otherwise ordinary tiers disagree", () => {
    const left = assessmentFixture(); const right = assessmentFixture();
    right.ranking.tier = { status: "assessed", value: "not_v1", rationale: "Outside milestone scope." };
    const agreement = classifyStewardshipAssessmentAgreement(left, right);
    expect(agreement.ranking?.tier).toEqual({ status: "needs_evidence", cause: "disagreed" });
    expect(agreement.expand).toBe(true);
    expect(stewardshipPhaseBTrigger(agreement, [[], []])).toEqual({ required: true, triggers: ["tier_needs_evidence"] });
  });
});

describe("ranking merge decision table", () => {
  it("accepts legacy archives but refuses proposed from a current live seat", async () => {
    const value = options();
    const legacy = legacyAssessmentFixture();
    expect(() => validateStewardshipAssessment(legacy, value.evidence, policy)).not.toThrow();
    const result = await assessStewardshipIssue({ ...value, seats: [value.seats[0], { ...value.seats[1],
      invoke: async ({ reserve }) => { reserve(); return { assessment: legacy, observedModel: "fixture" }; } }] });
    expect(result).toMatchObject({ status: "deferred", reason: "assessment_failed", diagnostics: [{ seat: "glm", code: "schema_invalid" }] });
    expect(result.assessments).toHaveLength(1);
  });
  it.each([
    { status: "assessed", value: 0, rationale: "Out of range." },
    { status: "assessed", value: 11, rationale: "Out of range." },
    { status: "assessed", value: 7.5, rationale: "Seat scores must be integers." },
    { status: "assessed", value: 8, rationale: " " },
    { status: "assessed", value: 8, rationale: "x".repeat(4001) },
    { status: "abstain", reason: " " },
    { status: "abstain", reason: "x".repeat(4001) },
    { status: "abstain", reason: "Missing evidence.", value: 8 },
    { status: "assessed", value: 8, rationale: "Supported.", reason: "Mixed variant." },
  ])("refuses invalid field discrimination or bounds: %#", (field) => {
    const assessment = assessmentFixture();
    expect(() => validateStewardshipAssessment({ ...assessment, ranking: { ...assessment.ranking, value: field } }, evidenceFixture(), policy)).toThrow();
  });
  it.each(["codex", "glm"] as const)("offers %s a discriminated JSON schema and the scope-only tier rubric", async (family) => {
    const value = options(); const invoke = vi.fn(pair()[0].invoke);
    const result = await assessStewardshipIssue({ ...value, seats: [{ ...value.seats[0], family, invoke,
      ...(family === "codex" ? { assessmentProtocol: STEWARDSHIP_ASTRA_ASSESSMENT_PROTOCOL } : {}) },
      { ...value.seats[1], family: family === "codex" ? "glm" : "codex",
        ...(family === "glm" ? { assessmentProtocol: STEWARDSHIP_ASTRA_ASSESSMENT_PROTOCOL } : {}) }] });
    expect(result.status).toBe("assessed");
    const prompt = invoke.mock.calls[0][0].prompt;
    expect(prompt).not.toContain("no longer meaningful");
    expect(prompt).toContain("Judge tier on scope independently of done/stale");
    const schema = JSON.parse(prompt.split("Output JSON schema: ")[1].split("\n\n")[0]);
    expect(schema.properties).not.toHaveProperty("proposed");
    for (const field of Object.values(schema.properties.ranking.properties) as { oneOf: unknown[] }[]) expect(field.oneOf).toHaveLength(2);
  });
  it.each(["value", "tier", "effort", "severity", "lane", "milestoneStep", "doneStale", "codeNeeded"] as const)("refuses invalid %s from one seat without a partial merge", async (field) => {
    const value = options(); const bad = structuredClone(assessmentFixture());
    if (field === "codeNeeded") Object.assign(bad, { codeNeeded: ["lane"] });
    else Object.assign(bad.ranking, { [field]: { status: "assessed", value: "invalid", rationale: "Current evidence." } });
    const result = await assessStewardshipIssue({ ...value, seats: [value.seats[0], { ...value.seats[1],
      invoke: async ({ reserve }) => { reserve(); return { assessment: bad, observedModel: "fixture" }; } }] });
    expect(result).toMatchObject({ status: "deferred", reason: "assessment_failed", diagnostics: [
      { seat: "glm", stage: "schema", code: "schema_invalid" },
    ] });
    expect(result.assessments).toHaveLength(1); expect(value.reserveExpansion).not.toHaveBeenCalled();
    const decision = compileStewardshipDecision({ ...value, assessments: result.assessments, now, census: { complete: true, nowCount: 0 } });
    expect(decision.operations).toEqual([]); expect(decision).not.toHaveProperty("ranking");
  });
  it.each([
    ["tier", "blocks_milestone", "blocks_milestone", { status: "merged", value: "blocks_milestone" }],
    ["tier", "blocks_milestone", "not_v1", { status: "needs_evidence", cause: "disagreed" }],
    ["lane", "product", "tooling", { status: "needs_evidence", cause: "disagreed" }],
    ["milestoneStep", 6, 6, { status: "merged", value: 6 }],
    ["milestoneStep", 6, 8, { status: "needs_evidence", cause: "disagreed" }],
    ["effort", "low", "low", { status: "merged", value: "low" }],
    ["effort", "low", "medium", { status: "merged", value: "medium" }],
    ["effort", "medium", "high", { status: "merged", value: "high" }],
    ["effort", "low", "high", { status: "needs_evidence", cause: "disagreed" }],
    ["value", 8, 7, { status: "merged", value: 7.5 }],
    ["severity", "P0", "P0", { status: "merged", value: "P0" }],
    ["severity", "P1", "P2", { status: "needs_evidence", cause: "disagreed" }],
  ] as const)("%s: %s / %s", (field, a, b, expected) => {
    const left = { ...rankingFixture(), [field]: { status: "assessed", value: a, rationale: "Left evidence." } };
    const right = { ...rankingFixture(), [field]: { status: "assessed", value: b, rationale: "Right evidence." } };
    const schema = stewardshipAssessmentSchema.shape.ranking;
    expect(merge(schema.parse(left), schema.parse(right))[field]).toEqual(expected);
    expect(merge(schema.parse(right), schema.parse(left))[field]).toEqual(expected);
  });
  it.each(["lane", "tier", "milestoneStep", "value", "effort", "severity"] as const)("%s abstention never produces a value or disagreement", (field) => {
    const left = rankingFixture(); left[field] = { status: "abstain", reason: "Missing evidence." };
    for (const right of [rankingFixture(), left]) {
      expect(merge(left, right)[field]).toEqual({ status: "needs_evidence", cause: "abstained" });
      expect(merge(right, left)[field]).toEqual({ status: "needs_evidence", cause: "abstained" });
    }
  });
  it.each(["done", "stale", "abstain"] as const)("keeps each seat's %s flag independently of tier", (flag) => {
    const left = rankingFixture(); const right = rankingFixture();
    left.doneStale = flag === "abstain" ? { status: "abstain", reason: "Missing evidence." }
      : { status: "assessed", value: flag, rationale: "Current evidence." };
    const merged = merge(left, right);
    expect(merged.doneStale).toEqual({ seats: [left.doneStale, right.doneStale],
      ...(flag === "abstain" ? { status: "needs_evidence", cause: "abstained" } : { status: "reported" }) });
    expect(merged.tier).toEqual({ status: "merged", value: "blocks_milestone" });
  });
});

function pair(evidence = evidenceFixture()): readonly StewardshipSeat[] {
  return (["anthropic", "glm"] as const).map((family) => ({ family, requestedModel: family,
    invoke: async ({ reserve }: SeatInput) => { reserve(); return { assessment: assessmentFixture(evidence), observedModel: "unknown" }; } }));
}
function options(evidence = evidenceFixture()) { return { evidence, policy, seats: pair(evidence), now: () => now, deadlineAt: "2026-09-23T12:55:00Z", reserveCall: vi.fn<(attempt: number) => void>(), archive: vi.fn(),
  reserveExpansion: vi.fn(() => { throw new Error("Unexpected expansion"); }), expand: vi.fn(async () => { throw new Error("Unexpected expansion"); }) }; }

it("joins both turns after startup and retains each call's separate cached and uncached usage", async () => {
  const value = options();
  let ready!: () => void; let release!: () => void;
  const startup = new Promise<void>((resolve) => { ready = resolve; });
  const turns = new Promise<void>((resolve) => { release = resolve; });
  const started: string[] = [];
  const usage = { inputTokens: 100, cachedInputTokens: 75, uncachedInputTokens: 25, outputTokens: 9 };
  const seats: StewardshipSeat[] = ["codex", "glm"].map((family) => ({
    family: family as StewardshipSeat["family"], requestedModel: family,
    ...(family === "codex" ? { start: () => startup, assessmentProtocol: STEWARDSHIP_ASTRA_ASSESSMENT_PROTOCOL } : {}),
    invoke: async ({ reserve, recordUsage }) => {
      reserve(); started.push(family); await turns; recordUsage?.(family === "codex" ? usage : "unknown");
      return { assessment: assessmentFixture(), observedModel: "fixture" };
    },
  }));
  const pending = assessStewardshipIssue({ ...value, seats });
  await Promise.resolve(); expect(started).toEqual([]);
  ready(); await vi.waitFor(() => expect(started).toEqual(["codex", "glm"]));
  release(); const result = await pending;
  expect(result.status).toBe("assessed"); expect(result.assessments).toHaveLength(2);
  expect(result).toMatchObject({ usage: { seats: [
    { seat: "codex", phase: "initial", attempt: 1, usage },
    { seat: "glm", phase: "initial", attempt: 1, usage: "unknown" },
  ] } });
});

it("awaits and archives the other seat after one joined turn refuses", async () => {
  const value = options(); let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  let completed = false;
  const pending = assessStewardshipIssue({ ...value, seats: [
    { ...value.seats[0], invoke: async ({ reserve }) => { reserve(); throw new Error("refused"); } },
    { ...value.seats[1], invoke: async ({ reserve }) => { reserve(); await wait; return { assessment: assessmentFixture(), observedModel: "fixture" }; } },
  ] }).then((result) => { completed = true; return result; });
  await Promise.resolve(); expect(completed).toBe(false); release();
  const result = await pending;
  expect(result).toMatchObject({ status: "deferred", reason: "assessment_failed" });
  expect(result.assessments).toHaveLength(1);
  expect(result.assessments[0].envelope.seat.family).toBe("glm");
});
function expansionPair(initial: ReturnType<typeof evidenceFixture>, expanded: ReturnType<typeof evidenceFixture>, stillDisagrees = false) {
  let calls = 0;
  return (["anthropic", "glm"] as const).map((family) => ({ family, requestedModel: family,
    invoke: vi.fn(async ({ reserve }: SeatInput) => { reserve();
      const evidence = calls++ < 2 ? initial : expanded;
      const assessment = assessmentFixture(evidence);
      assessment.ranking.tier = rankingFixture().tier;
      assessment.codeNeeded = ["tier"];
      if (family === "glm" && (evidence === initial || stillDisagrees)) assessment.ranking.tier = { status: "assessed", value: "not_v1", rationale: "Outside the first milestone." };
      return { assessment, observedModel: "unknown" };
    }) }));
}

describe("stewardship blind assessment", () => {
  it.each([
    ["Priority", "codex"], ["Priority", "glm"], ["Priority", "both"],
    ["Horizon", "codex"], ["Horizon", "glm"], ["Horizon", "both"],
  ] as const)("treats %s abstention by %s as needs evidence before any agreement path", (field, abstainingSeat) => {
    const evidence = evidenceFixture();
    const left = legacyAssessmentFixture(evidence); const right = legacyAssessmentFixture(evidence);
    left.proposed = { Priority: "P2", Horizon: "Later" }; right.proposed = { ...left.proposed };
    if (abstainingSeat !== "glm") left.proposed[field] = null;
    if (abstainingSeat !== "codex") right.proposed[field] = null;
    right.clauses[0].status = "fulfilled";
    const hold = { kind: "operator" as const, value: "P2" as const, frontier: evidence.packet.fieldHistory.Priority.frontier,
      at: now, materialEvidenceSha256: evidence.packet.materialEvidenceSha256 };
    for (const context of [undefined, { evidence }, { evidence, holds: { Priority: hold } }]) {
      expect(classifyStewardshipAssessmentAgreement(left, right, context)).toEqual({ path: "deferred", reason: "needs_evidence", expand: false });
    }
    left.supersedesHold = { previousEvidenceSha256s: [evidence.packet.materialEvidenceSha256],
      changedFactIds: [evidence.packet.facts[0].factId], statement: "A changed fact." };
    expect(classifyStewardshipAssessmentAgreement(left, right, { evidence })).toEqual({ path: "deferred", reason: "needs_evidence", expand: false });
  });
  it.each([
    ["completion", "already_complete_requires_lifecycle_review"],
    ["premise", "premise_requires_rescoping"],
    ["choice", "unresolved_product_choice"],
  ] as const)("keeps the %s escalation when a seat abstains", (signal, reason) => {
    const evidence = evidenceFixture();
    const left = legacyAssessmentFixture(evidence); const right = legacyAssessmentFixture(evidence);
    left.proposed = { Priority: null, Horizon: null }; right.proposed = { Priority: "P2", Horizon: "Later" };
    if (signal === "completion") left.completion = "complete";
    else if (signal === "premise") left.premise = "disproved";
    else left.unresolvedChoices = ["Choose the intake contract"];
    const hold = { kind: "operator" as const, value: "P2" as const, frontier: evidence.packet.fieldHistory.Priority.frontier,
      at: now, materialEvidenceSha256: evidence.packet.materialEvidenceSha256 };
    for (const context of [undefined, { evidence }, { evidence, holds: { Priority: hold } }]) {
      expect(classifyStewardshipAssessmentAgreement(left, right, context)).toEqual({ path: "escalated", reason, expand: false });
      expect(classifyStewardshipAssessmentAgreement(right, left, context)).toEqual({ path: "escalated", reason, expand: false });
    }
  });
  it.each([
    ["completion", "already_complete_requires_lifecycle_review"],
    ["premise", "premise_requires_rescoping"],
  ] as const)("compiles an abstaining seat's %s signal as an escalation without expansion", async (signal, reason) => {
    const evidence = evidenceFixture(); const value = options(evidence);
    const seats = (["codex", "glm"] as const).map((family) => ({ family, requestedModel: family === "codex" ? "gpt-6-astra" : "glm-5.3",
      ...(family === "codex" ? { assessmentProtocol: STEWARDSHIP_ASTRA_ASSESSMENT_PROTOCOL } : {}),
      invoke: async ({ reserve }: SeatInput) => { reserve();
        const assessment = assessmentFixture(evidence);
        if (family === "codex") {
          assessment.ranking.severity = { status: "abstain", reason: "Missing code evidence." };
          if (signal === "completion") assessment.completion = "complete"; else assessment.premise = "disproved";
        }
        return { assessment, observedModel: "fixture" };
      } }));
    const result = await assessStewardshipIssue({ ...value, seats });
    expect(result.status).toBe("assessed");
    expect(value.reserveExpansion).not.toHaveBeenCalled(); expect(value.expand).not.toHaveBeenCalled();
    expect(compileStewardshipDecision({ evidence: result.evidence, assessments: result.assessments, policy, now,
      census: { complete: true, nowCount: 0 } })).toMatchObject({ status: "escalated", reasons: [reason], operations: [] });
  });
  it.each([
    ["severity", "codex"], ["severity", "glm"], ["severity", "both"],
    ["tier", "codex"], ["tier", "glm"], ["tier", "both"],
  ] as const)("records Phase B %s abstention by %s without a second expansion", async (field, abstainingSeat) => {
    const evidence = rebind({ ...evidenceFixture(), packet: { ...evidenceFixture().packet, evidencePhase: "expanded" } }); const value = options(evidence);
    const seats = (["codex", "glm"] as const).map((family) => ({ family, requestedModel: family === "codex" ? "gpt-6-astra" : "glm-5.3",
      ...(family === "codex" ? { assessmentProtocol: STEWARDSHIP_ASTRA_ASSESSMENT_PROTOCOL } : {}),
      invoke: async ({ reserve }: SeatInput) => { reserve();
        const assessment = assessmentFixture(evidence);
        if (abstainingSeat === "both" || abstainingSeat === family) assessment.ranking[field] = { status: "abstain", reason: "Missing evidence." };
        return { assessment, observedModel: "fixture" };
      } }));
    const result = await assessStewardshipIssue({ ...value, seats });
    expect(result.status).toBe("assessed"); expect(result.assessments).toHaveLength(2);
    expect(value.reserveCall).toHaveBeenCalledTimes(2);
    expect(value.reserveExpansion).not.toHaveBeenCalled(); expect(value.expand).not.toHaveBeenCalled();
    for (const entry of result.assessments) expect(value.archive).toHaveBeenCalledWith(entry.envelope);
    const decision = compileStewardshipDecision({ evidence: result.evidence, assessments: result.assessments, policy, now,
      census: { complete: true, nowCount: 0 } });
    expect(decision).toMatchObject({ status: "no-change", reasons: ["awaiting_backlog_compile"], path: "awaiting_backlog_compile", operations: [],
      ranking: { [field]: { status: "needs_evidence", cause: "abstained" }, lane: { status: "merged", value: "product" } } });
  });
  it("round-trips an archived anthropic assessment envelope without changing its hash", () => {
    const evidence = evidenceFixture();
    const archived = freezeStewardshipAssessment({ evidence, policy, assessment: legacyAssessmentFixture(evidence), assessedAt: now,
      seat: { family: "anthropic", requestedModel: "opus", observedModel: "unknown" } });
    const parsed = stewardshipAssessmentEnvelopeSchema.parse(JSON.parse(JSON.stringify(archived.envelope)));
    expect(parsed).toEqual(archived.envelope); expect(parsed.seat.family).toBe("anthropic");
    expect(canonicalJsonSha256(parsed)).toBe(archived.sha256);
  });
  it("accepts and compiles an independent codex and glm assessment pair", async () => {
    const value = options();
    const result = await assessStewardshipIssue({ ...value,
      seats: [{ ...value.seats[0], family: "codex", requestedModel: "gpt-6-astra", assessmentProtocol: STEWARDSHIP_ASTRA_ASSESSMENT_PROTOCOL }, value.seats[1]] });
    expect(result.status).toBe("assessed");
    expect(result.assessments.map((entry) => entry.envelope.seat.family)).toEqual(["codex", "glm"]);
    expect(result.assessments[0].envelope.seat.assessmentProtocol).toBe(STEWARDSHIP_ASTRA_ASSESSMENT_PROTOCOL);
    expect(result.assessments[1].envelope.seat).not.toHaveProperty("assessmentProtocol");
    expect(value.reserveCall).toHaveBeenCalledTimes(2);
    for (const entry of result.assessments) expect(value.archive).toHaveBeenCalledWith(entry.envelope);
    const decision = compileStewardshipDecision({ evidence: value.evidence, policy, assessments: result.assessments, now,
      census: { complete: true, nowCount: 0 } });
    expect(decision.status).not.toBe("deferred"); expect(decision.seatFamilies).toEqual(["codex", "glm"]);
  });
  it("defers a codex and codex pair before reserving or invoking a seat", async () => {
    const value = options(); const invoke = vi.fn(value.seats[0].invoke);
    const seats = value.seats.map((seat) => ({ ...seat, family: "codex" as const, requestedModel: "gpt-6-astra", invoke }));
    const result = await assessStewardshipIssue({ ...value, seats });
    expect(result).toMatchObject({ status: "deferred", reason: "independent_seats_required", assessments: [] });
    expect(value.reserveCall).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled(); expect(value.archive).not.toHaveBeenCalled();
  });
  it("names codex in the diagnostic for a failing codex seat", async () => {
    const value = options();
    const invoke = vi.fn(async ({ reserve }: SeatInput) => { reserve(); throw new StewardshipAssessmentError({ stage: "transport", code: "assessment_exit_failed", field: "$" }); });
    const result = await assessStewardshipIssue({ ...value,
      seats: [{ ...value.seats[0], family: "codex", requestedModel: "gpt-6-astra", invoke }, value.seats[1]] });
    expect(result).toMatchObject({ status: "deferred", reason: "assessment_failed" });
    expect(result.diagnostics).toEqual([{ seat: "codex", stage: "transport", code: "assessment_exit_failed", field: "$" }]);
  });
  it.each(["paused", "run_deadline", "call_budget"] as const)("classifies typed %s independently of its prose", async (code) => {
    const value = options(); const refusal = new StewardshipReservationRefusal(code,
      code === "paused" ? "Stewardship is paused" : code === "run_deadline" ? "Run deadline exceeded" : "Assessment budget exhausted");
    refusal.message = "different display text";
    const invoke = vi.fn(async ({ reserve }: SeatInput) => { reserve(); throw new StewardshipAssessmentError({ stage: "transport", code: "assessment_timeout", field: "$" }); });
    const result = await assessStewardshipIssue({ ...value, seats: [{ ...pair()[0], invoke }, pair()[1]],
      reserveCall: (attempt) => { if (attempt === 2) throw refusal; } });
    expect(result.reason).toBe(code === "call_budget" ? "call_budget_exhausted" : "assessment_timeout");
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.diagnostics).toHaveLength(1);
  });
  it.each(["paused", "run_deadline"] as const)("records first-attempt versus retry classification for real %s reservations", async (code) => {
    const root = mkdtempSync(join(tmpdir(), "reservation-refusal-"));
    const location = { root, repository: policy.repository, policy };
    const store = await acquireStewardshipStore({ ...location, owner: "test", initialize: { adoptionId: "reservation", at: now, census: { complete: true, issues: [] } } });
    try {
      for (const refusingAttempt of [1, 2]) {
        setStewardshipPaused({ ...location, paused: false, at: now });
        const runId = `run-${refusingAttempt}`; store.append({ type: "run-started", runId }, now);
        const invoke = vi.fn(async ({ reserve }: SeatInput) => { reserve(); throw new StewardshipAssessmentError({ stage: "transport", code: "assessment_timeout", field: "$" }); });
        const result = await assessStewardshipIssue({ ...options(), seats: [{ ...pair()[0], invoke }, pair()[1]], reserveCall: (attempt) => {
          let at = now;
          if (attempt === refusingAttempt) {
            if (code === "paused") setStewardshipPaused({ ...location, paused: true, at });
            else at = new Date(Date.parse(now) + policy.limits.runDurationMs).toISOString();
          }
          store.append({ type: "assessment-started", runId, attempt }, at);
        } });
        // Existing semantics differ: a first-attempt refusal has no preceding timeout.
        expect(result.reason).toBe(refusingAttempt === 1 ? "assessment_refused" : "assessment_timeout");
        expect(invoke).toHaveBeenCalledTimes(refusingAttempt);
        expect(store.state.runs[runId].assessmentCalls).toBe(refusingAttempt === 1 ? 0 : 2);
      }
    } finally { store.release(); rmSync(root, { recursive: true, force: true }); }
  });
  it("bounds a worst-case recovered and expanded issue to six calls within the v2 run", async () => {
    const initial = evidenceFixture(); const expanded = rebind({ ...initial, packet: { ...initial.packet, evidencePhase: "expanded" } });
    let clock = Date.parse(now); const value = options(initial); const counts = new Map<string, number>();
    const seats = pair().map((seat) => ({ ...seat, invoke: async ({ prompt, timeoutMs, reserve }: SeatInput) => { reserve();
      const phase = JSON.parse(prompt.split("UNTRUSTED EVIDENCE PACKET\n")[1].split("\n\n")[0]).evidencePhase;
      const key = `${seat.family}:${phase}`; const attempt = (counts.get(key) ?? 0) + 1; counts.set(key, attempt);
      clock += timeoutMs;
      if (phase === "initial" && attempt === 1) throw new StewardshipAssessmentError({ stage: "transport", code: "assessment_timeout", field: "$" });
      const assessment = assessmentFixture(phase === "initial" ? initial : expanded);
      assessment.codeNeeded = ["effort"];
      if (phase === "initial" && seat.family === "glm") assessment.ranking.tier = { status: "assessed", value: "not_v1", rationale: "Outside the first milestone." };
      return { assessment, observedModel: "fixture" };
    } }));
    const result = await assessStewardshipIssue({ ...value, seats, now: () => new Date(clock).toISOString(), reserveExpansion: () => {}, expand: async () => expanded });
    expect(result.status).toBe("assessed"); expect(value.reserveCall).toHaveBeenCalledTimes(6);
    expect(clock - Date.parse(now)).toBe(24 * 60_000); expect(clock).toBeLessThan(Date.parse(value.deadlineAt));
  });
  it("does not retry an unclassified timeout message", async () => {
    const invoke = vi.fn(async ({ reserve }: SeatInput) => { reserve(); throw new Error("assessment_timeout"); });
    await assessStewardshipIssue({ ...options(), seats: [{ ...pair()[0], invoke }, pair()[1]] });
    expect(invoke).toHaveBeenCalledOnce();
  });
  it("allows a retry at exactly one full attempt budget of remaining run time", async () => {
    const value = options(); let clock = Date.parse(now);
    const invoke = vi.fn(pair()[0].invoke).mockImplementationOnce(async ({ reserve }: SeatInput) => { reserve();
      clock = Date.parse(value.deadlineAt) - policy.limits.assessmentTimeoutMs - STEWARDSHIP_SEAT_STARTUP_MS;
      throw new StewardshipAssessmentError({ stage: "transport", code: "assessment_timeout", field: "$" });
    });
    const result = await assessStewardshipIssue({ ...value, now: () => new Date(clock).toISOString(), seats: [{ ...pair()[0], invoke }, pair()[1]] });
    expect(result.status).toBe("assessed"); expect(invoke).toHaveBeenCalledTimes(2);
  });
  it.each([0, 1])("retries seat %s once with the identical prompt and reserves attempts separately", async (index) => {
    const value = options(); const seats = [...pair()];
    const invoke = vi.fn(seats[index].invoke).mockImplementationOnce(async ({ reserve }) => { reserve(); throw new StewardshipAssessmentError({ stage: "transport", code: "assessment_timeout", field: "$" }); });
    seats[index] = { ...seats[index], invoke };
    const result = await assessStewardshipIssue({ ...value, seats });
    expect(result.status).toBe("assessed"); expect(value.reserveCall).toHaveBeenCalledTimes(3);
    expect(value.reserveCall.mock.calls.map((call) => call[0])).toEqual([1, 1, 2]);
    expect(invoke.mock.calls[0][0]).toEqual({ ...invoke.mock.calls[1][0], reserve: expect.any(Function), recordUsage: expect.any(Function) });
    expect(result.usage.seats.filter((call) => call.seat === seats[index].family).map((call) => call.attempt)).toEqual([1, 2]);
  });
  it("ends an issue after two timeouts without a third attempt", async () => {
    const value = options();
    const invoke = vi.fn(async ({ reserve }: SeatInput) => { reserve(); throw new StewardshipAssessmentError({ stage: "transport", code: "assessment_timeout", field: "$" }); });
    const result = await assessStewardshipIssue({ ...value, seats: [{ ...pair()[0], invoke }, pair()[1]] });
    expect(result).toMatchObject({ status: "deferred", reason: "assessment_timeout" });
    expect(invoke).toHaveBeenCalledTimes(2); expect(value.reserveCall).toHaveBeenCalledTimes(3);
  });
  it.each(["short_time", "budget", "paused", "expanded"])("skips a timeout retry for %s", async (boundary) => {
    const initial = evidenceFixture();
    const evidence = boundary === "expanded" ? rebind({ ...initial, packet: { ...initial.packet, evidencePhase: "expanded" as const } }) : initial;
    const value = options(evidence); let calls = 0;
    const reserveCall = vi.fn(() => { if (boundary === "budget" && calls === 1) throw new StewardshipReservationRefusal("call_budget", "call_budget_exhausted"); if (boundary === "paused" && calls === 1) throw new StewardshipReservationRefusal("paused", "Stewardship is paused"); calls++; });
    const invoke = vi.fn(async ({ reserve }: SeatInput) => { reserve(); throw new StewardshipAssessmentError({ stage: "transport", code: "assessment_timeout", field: "$" }); });
    const result = await assessStewardshipIssue({ ...value, reserveCall, deadlineAt: boundary === "short_time" ? "2026-09-23T12:03:59Z" : value.deadlineAt,
      seats: [{ ...pair(evidence)[0], invoke }, pair(evidence)[1]] });
    expect(invoke).toHaveBeenCalledOnce();
    expect(calls).toBe(boundary === "budget" || boundary === "paused" ? 1 : 2);
    expect(result.reason).toBe(boundary === "budget" ? "call_budget_exhausted" : "assessment_timeout");
  });
  it.each(["assessment_cleanup_failed", "assessment_output_limit", "refused"] as const)("never retries %s", async (code) => {
    const invoke = vi.fn(async ({ reserve }: SeatInput) => { reserve(); throw new StewardshipAssessmentError({ stage: "transport", code, field: "$" }); });
    await assessStewardshipIssue({ ...options(), seats: [{ ...pair()[0], invoke }, pair()[1]] });
    expect(invoke).toHaveBeenCalledOnce();
  });
  it("retains the first seat's valid assessment when the second seat times out", async () => {
    const result = await assessStewardshipIssue({ ...options(), seats: [pair()[0], { ...pair()[1], invoke: async ({ reserve }: SeatInput) => { reserve();
      throw new StewardshipAssessmentError({ stage: "transport", code: "assessment_timeout", field: "$" });
    } }] });
    expect(result.reason).toBe("assessment_timeout");
    expect(result.assessments.map((entry) => entry.envelope.seat.family)).toEqual(["anthropic"]);
  });
  it("wires a run rejection to one owner-only archive file and a matching journal hash", async () => {
    const root = mkdtempSync(join(tmpdir(), "stewardship-rejection-cycle-"));
    try {
      const evidence = evidenceFixture(); const packet = evidence.packet;
      type Dependencies = NonNullable<Parameters<typeof runRoadmapSort>[1]>;
      // Only fields consumed by the cycle are needed from the mocked collector.
      const generation: Partial<ReturnType<NonNullable<Dependencies["collect"]>>> = { originMainSha: evidence.originMainSha, policySha256: evidence.policySha256, packets: [packet], deferredIssues: [],
        baselines: [{ issueNumber: 1, materialEvidenceSha256: packet.materialEvidenceSha256, fields: { Priority: "P2", Horizon: "Later" },
          frontiers: { Priority: packet.fieldHistory.Priority.frontier, Horizon: packet.fieldHistory.Horizon.frontier } }],
        census: { complete: true, totalCount: 1, nowCount: 0, issueNumbers: [1] } };
      const dependencies = { root, policy, now: () => now, assertCheckout: () => {}, collect: () => generation as ReturnType<NonNullable<Dependencies["collect"]>>,
        createGitHub: vi.fn(() => { throw new Error("Unexpected GitHub access"); }),
        seats: [pair()[0], { ...pair()[1], invoke: async ({ reserve }: SeatInput) => { reserve(); return { assessment: { rationale: "private-rejected-cycle-answer" }, observedModel: "fixture" }; } }] };
      await runRoadmapSort(["init"], dependencies);
      const report = await runRoadmapSort(["run"], dependencies);
      const paths = stewardshipPaths({ root, repository: policy.repository });
      const files = readdirSync(paths.rejectedAnswers); expect(files).toHaveLength(1);
      const path = join(paths.rejectedAnswers, files[0]);
      const entry = JSON.parse(readFileSync(path, "utf8"));
      expect(entry.content).toContain("private-rejected-cycle-answer");
      expect(entry.sha256).toBe(sha256Bytes(entry.content));
      expect(JSON.stringify(report)).toContain(entry.sha256);
      expect(JSON.stringify(report)).not.toContain("private-rejected-cycle-answer");
      const journal = readFileSync(paths.journal, "utf8");
      expect(journal).not.toContain("private-rejected-cycle-answer");
      expect(journal.trim().split("\n").map((line) => JSON.parse(line).event)).toContainEqual({ type: "assessment-rejected",
        seat: "glm", stage: "schema", code: "schema_invalid", field: "$.binding", contentSha256: entry.sha256 });
      if (process.platform === "win32") {
        for (const target of [paths.rejectedAnswers, path]) {
          expect(existsSync(target)).toBe(true);
          const acl = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
            "$ErrorActionPreference = 'Stop'; $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl = Get-Acl -LiteralPath $env:STEWARDSHIP_TEST_PATH; " +
            "$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])); " +
            "@{protected=$acl.AreAccessRulesProtected;owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;sid=$sid;rules=@($rules | ForEach-Object {$_.IdentityReference.Value})} | ConvertTo-Json -Compress"],
          { encoding: "utf8", windowsHide: true, env: { ...process.env, STEWARDSHIP_TEST_PATH: toNamespacedPath(target) } }));
          if (target === paths.rejectedAnswers) expect(acl.protected).toBe(true);
          expect(acl.rules).toContain(acl.sid);
          // The file inherits the shared private-directory DACL: the current user plus SYSTEM and Administrators only.
          expect(acl.rules.every((rule: string) => [acl.sid, "S-1-5-18", "S-1-5-32-544"].includes(rule))).toBe(true);
        }
      } else {
        expect(statSync(paths.rejectedAnswers).mode & 0o777).toBe(0o700);
        expect(statSync(path).mode & 0o777).toBe(0o600);
      }
      expect(() => readStewardshipState({ root, repository: policy.repository, policy })).not.toThrow();
      expect(dependencies.createGitHub).not.toHaveBeenCalled();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it.each(["schema", "response_safety", "response_json", "runtime", "credential_json"])("archives only safe complete bytes after %s rejection", async (failure) => {
    const secret = "configured-private-value"; const credential = "seat-local-private-value";
    const answer = failure === "response_json" ? `malformed ${secret}` : failure === "credential_json" ? `malformed ${credential}`
      : JSON.stringify({ rationale: failure === "response_safety" ? secret : "rejected-answer-marker" });
    const stdout = [JSON.stringify({ type: "system", subtype: "init", tools: failure === "runtime" ? ["Read"] : [], mcp_servers: [], model: "fixture" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: answer })].join("\n");
    const seats = createClaudeGlmStewardshipSeats({ runCli: async () => ({ stdout, stderr: "private-stderr" }), getZaiToken: () => credential,
      sensitiveValues: [secret] });
    const archiveRejected = vi.fn();
    const result = await assessStewardshipIssue({ ...options(), seats: [pair()[0], seats[1]], sensitiveValues: [secret], archiveRejected });
    expect(archiveRejected).toHaveBeenCalledOnce();
    const [archived, diagnostic] = archiveRejected.mock.calls[0];
    expect(archived).toEqual({ sha256: sha256Bytes(stdout), byteLength: Buffer.byteLength(stdout),
      ...(["schema", "runtime"].includes(failure) ? { content: stdout } : {}) });
    expect(diagnostic).toMatchObject({ seat: "glm", stage: failure === "credential_json" ? "response_json" : failure });
    expect(result.diagnostics[0]).toMatchObject({ contentSha256: sha256Bytes(stdout) });
    expect(JSON.stringify(result)).not.toMatch(/rejected-answer-marker|configured-private-value|seat-local-private-value|private-stderr/);
  });
  it("does not archive transport failures or successful answers", async () => {
    const archiveRejected = vi.fn();
    const good = await assessStewardshipIssue({ ...options(), archiveRejected });
    expect(good.status).toBe("assessed");
    const seats = createClaudeGlmStewardshipSeats({ getZaiToken: () => "fixture-zai-credential", runCli: async () => { throw new Error("assessment_timeout"); } });
    await assessStewardshipIssue({ ...options(), seats, archiveRejected });
    expect(archiveRejected).not.toHaveBeenCalled();
  });
  it("screens configured values at the assessment boundary and keeps archive errors out of reports", async () => {
    const secret = "only-assessment-knows-this";
    const stdout = [JSON.stringify({ type: "system", subtype: "init", tools: [], mcp_servers: [], model: "fixture" }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: `malformed ${secret}` })].join("\n");
    const seats = createClaudeGlmStewardshipSeats({ runCli: async () => ({ stdout, stderr: "" }) });
    const archiveRejected = vi.fn(() => { throw new Error("private-archive-error"); });
    const result = await assessStewardshipIssue({ ...options(), seats, sensitiveValues: [secret], archiveRejected });
    expect(archiveRejected).toHaveBeenCalledWith({ sha256: sha256Bytes(stdout), byteLength: Buffer.byteLength(stdout) },
      { seat: "anthropic", stage: "response_json", code: "invalid_json", field: "$" });
    expect(result).toMatchObject({ status: "deferred", reason: "assessment_refused" });
    expect(result.diagnostics).toContainEqual({ seat: "anthropic", stage: "archive", code: "refused", field: "$" });
    expect(JSON.stringify(result)).not.toMatch(/only-assessment-knows-this|private-archive-error/);
  });
  it("screens decoded stream fields even when runtime validation rejects before parsing the answer", async () => {
    const credential = "seat-private-credential";
    const stdout = JSON.stringify({ type: "system", subtype: "init", tools: ["Read"], mcp_servers: [], model: credential })
      .replace(credential, "seat-private-credenti\\u0061l");
    const seat = createClaudeGlmStewardshipSeats({ runCli: async () => ({ stdout, stderr: "" }), getZaiToken: () => credential })[1];
    const archiveRejected = vi.fn();
    await assessStewardshipIssue({ ...options(), seats: [pair()[0], seat], archiveRejected });
    expect(archiveRejected.mock.calls[0][0]).toEqual({ sha256: sha256Bytes(stdout), byteLength: Buffer.byteLength(stdout) });
  });
  it("assesses both seats across policy epochs without treating tuning as changed hold facts", async () => {
    const old = rebind({ ...evidenceFixture(), policySha256: stewardshipPolicySha256(knownStewardshipPolicy("v1", policy)) }); const v2 = knownStewardshipPolicy("v2", policy);
    const evidence = rebind({ ...old, policySha256: stewardshipPolicySha256(v2) });
    const hold = { kind: "operator" as const, value: "P2" as const, frontier: old.packet.fieldHistory.Priority.frontier,
      materialEvidenceSha256: old.packet.materialEvidenceSha256, at: "2026-09-22T12:00:00Z" };
    const context = { holds: { Priority: hold }, heldEvidence: { [hold.materialEvidenceSha256]: old } };
    const invoke = vi.fn(pair(evidence)[0].invoke);
    const result = await assessStewardshipIssue({ ...options(evidence), policy: v2, ...context, seats: pair(evidence).map((seat) => ({ ...seat, invoke })) });
    expect(result.status).toBe("assessed"); expect(invoke).toHaveBeenCalledTimes(2);
    const decision = compileStewardshipDecision({ evidence, policy: v2, assessments: result.assessments, now, census: { complete: true, nowCount: 0 }, ...context });
    expect(decision.holdSupersessions).toEqual([]); expect(decision.path).toBe("awaiting_backlog_compile"); expect(decision.operations).toEqual([]);
  });
  it("reports only the failed seat, validation stage, code and safe field path", async () => {
    const evidence = evidenceFixture(); const value = options(evidence);
    const bad = assessmentFixture(evidence); bad.rubricFacts.worthwhile = { ...bad.rubricFacts.worthwhile!, evidenceIds: ["private-invalid-citation"] };
    const result = await assessStewardshipIssue({ ...value, seats: [pair(evidence)[0], { ...pair(evidence)[1],
      invoke: async ({ reserve }: SeatInput) => { reserve(); return { assessment: bad, observedModel: "fixture" }; } }] });
    expect(result).toMatchObject({ status: "deferred", reason: "assessment_failed", diagnostics: [
      { seat: "glm", stage: "citations", code: "absent_evidence", field: "$.rubricFacts.worthwhile.evidenceIds[0]" },
    ] });
    expect(JSON.stringify(result)).not.toContain("private-invalid-citation");
    expect(value.reserveExpansion).not.toHaveBeenCalled();
  });
  it("supplies an explicit citation catalog and packet-bound JSON schema", async () => {
    const evidence = evidenceFixture(); const invoke = vi.fn(pair(evidence)[0].invoke);
    await assessStewardshipIssue({ ...options(evidence), seats: pair(evidence).map((seat) => ({ ...seat, invoke })) });
    const prompt = invoke.mock.calls[0][0].prompt;
    expect(prompt).toContain("ALLOWED CITATION CATALOG");
    expect(prompt).toContain("Clause IDs and raw paths are not citation IDs");
    const schema = JSON.parse(prompt.split("Output JSON schema: ")[1].split("\n\n")[0]);
    expect(schema.properties.evidenceIds.items.$ref).toBe("#/$defs/citationId");
    expect(schema.$defs.citationId.enum).toEqual([evidence.packet.sources[0].evidenceId, evidence.packet.facts[0].factId]);
    expect(schema.properties.counterevidenceIds.items).toEqual(schema.properties.evidenceIds.items);
    expect(schema.properties.clauses).toMatchObject({ minItems: 1, maxItems: 1, items: false });
    expect(schema.properties.clauses.prefixItems[0].properties.clauseId.const).toBe(evidence.packet.clauses[0].clauseId);
    expect(schema.properties.clauses.prefixItems[0].properties.codeReferences.items.properties.evidenceId.enum).toEqual([evidence.packet.sources[0].evidenceId]);
    expect(schema.properties.binding.properties.packetSha256.const).toBe(canonicalJsonSha256(evidence.packet));
  });
  // Preview 199cfa2c: #375 carried symbol-discovered code that no clause collected, and #1240 had no clauses at all.
  // The prompt offered every packet code source to every clause, so an exact quote still failed validation.
  it("asks for exactly the collected clauses and only each clause's own code sources", async () => {
    const initial = evidenceFixture();
    const cases = [
      { evidence: rebind({ ...initial, packet: { ...initial.packet, clauses: [] } }), count: 0 },
      { evidence: rebind({ ...initial, packet: { ...initial.packet, clauses: initial.packet.clauses.map((clause) => ({ ...clause, evidenceIds: [] })) } }), count: 1 },
    ];
    for (const { evidence, count } of cases) {
      // An answer built only from what the prompt offers must pass the unchanged validator.
      const conforming = { ...assessmentFixture(evidence), clauses: evidence.packet.clauses.map((clause) => ({ clauseId: clause.clauseId,
        status: "unknown" as const, reason: "No code was collected for this clause.", codeReferences: [] })) };
      const invoke = vi.fn(async ({ reserve }: SeatInput) => { reserve(); return { assessment: conforming, observedModel: "fixture" }; });
      const result = await assessStewardshipIssue({ ...options(evidence), seats: pair(evidence).map((seat) => ({ ...seat, invoke })) });
      expect(result).toMatchObject({ status: "assessed", diagnostics: [] });
      const prompt: string = invoke.mock.calls[0][0].prompt;
      const schema = JSON.parse(prompt.split("Output JSON schema: ")[1].split("\n\n")[0]);
      expect(schema.properties.clauses).toMatchObject({ minItems: count, maxItems: count, items: false });
      if (count === 0) expect(schema.properties.clauses).not.toHaveProperty("prefixItems");
      expect(prompt).toContain(`REQUIRED CLAUSES (return exactly these, in order; [] means clauses must be [])\n${JSON.stringify(
        evidence.packet.clauses.map((clause) => ({ clauseId: clause.clauseId, codeSourceIds: [] })))}`);
      if (count > 0) expect(schema.properties.clauses.prefixItems[0].properties.codeReferences.maxItems).toBe(0);
      const packetCode = evidence.packet.sources[0].evidenceId;
      const offered = JSON.stringify(schema.properties.clauses);
      expect(offered).not.toContain(packetCode);
    }
  });
  it("sanitizes malformed keys, raw provider errors and quoted response bytes", async () => {
    const evidence = evidenceFixture(); const secret = "raw-private-error-or-key";
    for (const assessment of [{ ...assessmentFixture(evidence), [secret]: secret },
      { ...assessmentFixture(evidence), rationale: { [secret]: secret } }]) {
      const result = await assessStewardshipIssue({ ...options(evidence), seats: [pair(evidence)[0], { ...pair(evidence)[1],
        invoke: async ({ reserve }: SeatInput) => { reserve(); return { assessment, observedModel: "fixture" }; } }] });
      expect(result.diagnostics[0]).toMatchObject({ seat: "glm", stage: "schema", code: "schema_invalid" });
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    const result = await assessStewardshipIssue({ ...options(evidence), seats: [pair(evidence)[0], { ...pair(evidence)[1],
      invoke: async ({ reserve }: SeatInput) => { reserve(); throw new Error(secret); } }] });
    expect(result.diagnostics).toEqual([{ seat: "glm", stage: "transport", code: "refused", field: "$" }]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("does not expand an ordinary Priority pair for alternate valid citations or irrelevant rubric slots", async () => {
    const evidence = evidenceFixture(); const value = options(evidence);
    const right = structuredClone(assessmentFixture(evidence));
    right.rubricFacts.worthwhile!.evidenceIds = [evidence.packet.facts[0].factId]; right.rubricFacts.remainingGap = null;
    const result = await assessStewardshipIssue({ ...value, seats: [pair(evidence)[0], { ...pair(evidence)[1],
      invoke: async ({ reserve }: SeatInput) => { reserve(); return { assessment: right, observedModel: "fixture" }; } }] });
    expect(result.status).toBe("assessed"); expect(value.reserveExpansion).not.toHaveBeenCalled();
  });
  it.each(["no-change", "change"])("does not expand an agreed ordinary %s for different choices or clause statuses", async (kind) => {
    const evidence = evidenceFixture(); const value = options(evidence);
    const seats = pair(evidence).map((seat) => ({ ...seat, invoke: async ({ reserve }: SeatInput) => { reserve();
      const assessment = assessmentFixture(evidence);
      if (kind === "no-change") assessment.ranking.severity = { status: "assessed", value: "P2", rationale: "Workaround exists." };
      assessment.unresolvedChoices = [seat.family === "glm" ? "Choose the consumer contract" : "Choose the output contract"];
      if (seat.family === "glm") assessment.clauses[0].status = "fulfilled";
      return { assessment, observedModel: "fixture" };
    } }));
    const result = await assessStewardshipIssue({ ...value, seats });
    expect(result.status).toBe("assessed"); expect(value.reserveCall).toHaveBeenCalledTimes(2);
    expect(value.reserveExpansion).not.toHaveBeenCalled(); expect(value.expand).not.toHaveBeenCalled();
  });
  it("expands a P2 versus P3 split once using fresh assessments", async () => {
    const initial = evidenceFixture(); const expanded = rebind({ ...initial, packet: { ...initial.packet, evidencePhase: "expanded" } });
    const value = options(initial); const reserveExpansion = vi.fn(); const expand = vi.fn(async () => expanded);
    let calls = 0;
    const seats = pair(initial).map((seat) => ({ ...seat, invoke: async ({ reserve }: SeatInput) => { reserve();
      const evidence = calls++ < 2 ? initial : expanded; const assessment = assessmentFixture(evidence);
      if (evidence === initial && seat.family === "glm") assessment.ranking.severity = { status: "assessed", value: "P2", rationale: "Workaround exists." };
      return { assessment, observedModel: "fixture" };
    } }));
    const result = await assessStewardshipIssue({ ...value, seats, reserveExpansion, expand });
    expect(result.status).toBe("assessed"); expect(value.reserveCall).toHaveBeenCalledTimes(4);
    expect(reserveExpansion).toHaveBeenCalledOnce(); expect(expand).toHaveBeenCalledOnce();
    expect(result.assessments.every(({ envelope }) => envelope.assessment.binding.materialEvidenceSha256 === expanded.packet.materialEvidenceSha256)).toBe(true);
  });
  it("keeps ranking independent of legacy eligibility disagreement without expanding evidence", async () => {
    const evidence = evidenceFixture(); const value = options(evidence);
    const right = assessmentFixture(evidence); right.independentlyCloseable = false; right.rubricFacts.worthwhile = null;
    const result = await assessStewardshipIssue({ ...value, seats: [pair(evidence)[0], { ...pair(evidence)[1],
      invoke: async ({ reserve }: SeatInput) => { reserve(); return { assessment: right, observedModel: "fixture" }; } }] });
    expect(result.status).toBe("assessed"); expect(value.reserveCall).toHaveBeenCalledTimes(2);
    expect(value.reserveExpansion).not.toHaveBeenCalled(); expect(value.expand).not.toHaveBeenCalled();
    expect(compileStewardshipDecision({ evidence: result.evidence, assessments: result.assessments, policy, now,
      census: { complete: true, nowCount: 0 } })).toMatchObject({ path: "awaiting_backlog_compile", operations: [] });
  });
  it("does not treat clause-status disagreement as ranking disagreement", async () => {
    const initial = evidenceFixture(); const expanded = rebind({ ...initial, packet: { ...initial.packet, evidencePhase: "expanded" } });
    const value = options(initial); const reserveExpansion = vi.fn(); const expand = vi.fn(async () => expanded);
    let calls = 0;
    const seats = pair(initial).map((seat) => ({ ...seat, invoke: async ({ reserve }: SeatInput) => { reserve();
      const evidence = calls++ < 2 ? initial : expanded; const assessment = assessmentFixture(evidence);
      assessment.sequencing.disposition = "now";
      if (seat.family === "glm") assessment.clauses[0].status = "fulfilled";
      return { assessment, observedModel: "fixture" };
    } }));
    const result = await assessStewardshipIssue({ ...value, seats, reserveExpansion, expand });
    expect(result.status).toBe("assessed"); expect(value.reserveCall).toHaveBeenCalledTimes(2);
    expect(reserveExpansion).not.toHaveBeenCalled(); expect(expand).not.toHaveBeenCalled();
  });
  it("reserves both calls durably, supplies identical blind prompts, and archives bound independent outputs", async () => {
    const evidence = evidenceFixture();
    const invoke = vi.fn(async ({ reserve }: SeatInput) => { reserve(); return { assessment: assessmentFixture(evidence), observedModel: "unknown" }; });
    const seats: readonly StewardshipSeat[] = [ { family: "anthropic", requestedModel: "opus", invoke }, { family: "glm", requestedModel: "glm-5.3", invoke } ];
    const reserveCall = vi.fn(); const archive = vi.fn();
    const result = await assessStewardshipIssue({ ...options(evidence), seats, reserveCall, archive });
    expect(result.status).toBe("assessed");
    expect(reserveCall).toHaveBeenCalledTimes(2);
    expect(archive).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls[0][0]).toEqual({ ...invoke.mock.calls[1][0], reserve: expect.any(Function), recordUsage: expect.any(Function) });
    expect(result.assessments.map((entry) => entry.envelope.seat.family)).toEqual(["anthropic", "glm"]);
    expect(Object.isFrozen(result.assessments[0].envelope.assessment)).toBe(true);
  });
  it("rejects invented citations, stale hashes and permissive extra output fields", () => {
    const evidence = evidenceFixture();
    for (const output of [ { ...assessmentFixture(evidence), evidenceIds: ["invented"] },
      { ...assessmentFixture(evidence), binding: { ...assessmentFixture(evidence).binding, originMainSha: "c".repeat(40) } },
      { ...assessmentFixture(evidence), eligible: true } ]) {
      expect(() => validateStewardshipAssessment(output, evidence, policy)).toThrow();
    }
  });
  it.each(["missing_quote", "strategy_only", "outside_clause"])("refuses %s as clause-level code proof after expansion", (failure) => {
    const initial = evidenceFixture();
    const evidence = rebind({ ...initial, packet: { ...initial.packet, evidencePhase: "expanded" as const,
      sources: initial.packet.sources.map((source) => ({ ...source, path: failure === "strategy_only" ? "STRATEGY.md" : source.path })),
      clauses: initial.packet.clauses.map((clause) => ({ ...clause, evidenceIds: failure === "outside_clause" ? [] : clause.evidenceIds })) } });
    const assessment = assessmentFixture(evidence);
    if (failure === "missing_quote") assessment.clauses[0].codeReferences[0].quote = "return invented_result;";
    expect(() => validateStewardshipAssessment(assessment, evidence, policy)).toThrow("invalid_code_quote");
  });
  it("missing family, malformed output and budget refusal never become one-model authorization", async () => {
    const evidence = evidenceFixture();
    const invoke = vi.fn(async ({ reserve }: SeatInput) => { reserve(); return { assessment: {}, observedModel: "unknown" }; });
    const seats: readonly StewardshipSeat[] = [{ family: "anthropic", requestedModel: "opus", invoke }, { family: "glm", requestedModel: "glm-5.3", invoke }];
    const result = await assessStewardshipIssue({ ...options(evidence), seats, reserveCall: () => {}, archive: () => {} });
    expect(result.status).toBe("deferred"); expect(result.assessments).toEqual([]);
    const refused = await assessStewardshipIssue({ ...options(evidence), seats, reserveCall: () => { throw new Error("budget"); }, archive: () => {} });
    expect(refused.status).toBe("deferred"); expect(invoke).toHaveBeenCalledTimes(3);
  });
  it("screens complete packets before archival, invocation or budget reservation", async () => {
    const base = evidenceFixture();
    const source = { ...base.packet.sources[0], text: "export const synthetic = 'sensitive-fixture-value';" };
    const hash = sha256Bytes(source.text);
    Object.assign(source, { snippetSha256: hash, byteLength: Buffer.byteLength(source.text) });
    const evidence = rebind({ ...base, packet: { ...base.packet, sources: [source] } });
    const value = options(evidence);
    const result = await assessStewardshipIssue({ ...value, sensitiveValues: ["sensitive-fixture-value"] });
    expect(result.status).toBe("deferred"); expect(value.archive).not.toHaveBeenCalled(); expect(value.reserveCall).not.toHaveBeenCalled();
  });
  it("does not launch the second seat after deadline and never starts after budget refusal", async () => {
    const value = options();
    let time = now;
    const first = vi.fn<StewardshipSeat["invoke"]>(async ({ reserve }: SeatInput) => { reserve(); time = "2026-09-23T12:56:00Z"; return { assessment: assessmentFixture(), observedModel: "unknown" }; });
    const second = vi.fn(pair()[1].invoke);
    const result = await assessStewardshipIssue({ ...value, now: () => time, seats: [{ ...pair()[0], invoke: first }, { ...pair()[1], invoke: second }] });
    expect(result.status).toBe("deferred"); expect(result.assessments).toEqual([]); expect(second).not.toHaveBeenCalled();
    expect(first.mock.calls[0][0].timeoutMs).toBe(240_000);
  });
  it("caps the child by remaining run deadline", async () => {
    const value = options(); const invoke = vi.fn(pair()[0].invoke);
    await assessStewardshipIssue({ ...value, deadlineAt: "2026-09-23T12:00:17Z", seats: [{ ...pair()[0], invoke }, pair()[1]] });
    expect(invoke.mock.calls[0][0].timeoutMs).toBe(17_000);
    expect(invoke.mock.calls[0][0].startupTimeoutMs).toBe(17_000);
  });
  it("one additive expansion invalidates the first pair and uses two fresh blind calls", async () => {
    const initial = evidenceFixture();
    const expanded = rebind({ ...initial, packet: { ...initial.packet, evidencePhase: "expanded" } });
    const value = options(initial); const reserveExpansion = vi.fn(); const expand = vi.fn(async () => expanded);
    const seats = expansionPair(initial, expanded);
    const result = await assessStewardshipIssue({ ...value, seats, reserveExpansion, expand });
    expect(result.status).toBe("assessed"); expect(value.reserveCall).toHaveBeenCalledTimes(4); expect(reserveExpansion).toHaveBeenCalledOnce(); expect(expand).toHaveBeenCalledOnce();
    expect(result.assessments.every((entry) => entry.envelope.assessment.binding.materialEvidenceSha256 === expanded.packet.materialEvidenceSha256)).toBe(true);
    expect(seats[0].invoke.mock.calls[1][0]).toEqual({ ...seats[1].invoke.mock.calls[1][0], reserve: expect.any(Function), recordUsage: expect.any(Function) });
  });
  it("persistent disagreement stops after one expanded pair and does not reuse original responses", async () => {
    const initial = evidenceFixture(); const expanded = rebind({ ...initial, packet: { ...initial.packet, evidencePhase: "expanded" } });
    const value = options(initial); const reserveExpansion = vi.fn();
    const result = await assessStewardshipIssue({ ...value, seats: expansionPair(initial, expanded, true), reserveExpansion, expand: async () => expanded });
    expect(value.reserveCall).toHaveBeenCalledTimes(4); expect(reserveExpansion).toHaveBeenCalledOnce();
    const [left, right] = result.assessments.map((entry) => stewardshipAssessmentSchema.parse(entry.envelope.assessment));
    expect(left.ranking.tier).toEqual({ status: "assessed", value: "blocks_milestone", rationale: "Generation cannot finish." });
    expect(right.ranking.tier).toEqual({ status: "assessed", value: "not_v1", rationale: "Outside the first milestone." });
    expect(compileStewardshipDecision({ evidence: result.evidence, assessments: result.assessments, policy, now,
      census: { complete: true, nowCount: 0 } })).toMatchObject({ status: "no-change", reasons: ["awaiting_backlog_compile"], path: "awaiting_backlog_compile", operations: [],
      ranking: { tier: { status: "needs_evidence", cause: "disagreed" } } });
  });
  it("supports exact-prefix source enlargement but refuses changed main, body or initial visible bytes", async () => {
    const fixture = evidenceFixture(); const fullText = `${fixture.packet.sources[0].text}export const additional = true;\n`; const fullHash = sha256Bytes(fullText);
    const source = { ...fixture.packet.sources[0], evidenceId: `source:${fullHash}`, contentSha256: fullHash, fullByteLength: Buffer.byteLength(fullText) };
    const initial = rebind({ ...fixture, packet: { ...fixture.packet, sources: [source],
      clauses: [{ ...fixture.packet.clauses[0], evidenceIds: [source.evidenceId] }],
      facts: [{ ...fixture.packet.facts[0], contentSha256: canonicalJsonSha256({ path: source.path, contentSha256: fullHash }), evidenceIds: [source.evidenceId] }] } });
    const expanded = rebind({ ...initial, packet: { ...initial.packet, evidencePhase: "expanded",
      sources: [{ ...source, text: fullText, byteLength: Buffer.byteLength(fullText), snippetSha256: sha256Bytes(fullText) }] } });
    const result = await assessStewardshipIssue({ ...options(initial), seats: expansionPair(initial, expanded), reserveExpansion: () => {}, expand: async () => expanded });
    expect(result.status).toBe("assessed");
    const changedMain = rebind({ ...expanded, originMainSha: "b".repeat(40) });
    const changedBytes = rebind({ ...expanded, packet: { ...expanded.packet, sources: [{ ...expanded.packet.sources[0], text: fullText.replace("null", "true"), snippetSha256: sha256Bytes(fullText.replace("null", "true")) }] } });
    for (const changed of [changedMain, changedBytes]) {
      const value = options(initial);
      const refused = await assessStewardshipIssue({ ...value, seats: expansionPair(initial, changed), reserveExpansion: () => {}, expand: async () => changed });
      expect(refused.status).toBe("deferred"); expect(refused.assessments).toEqual([]); expect(value.reserveCall).toHaveBeenCalledTimes(2);
    }
  });
  it("supplies both seats identical hold comparison derived from archived visible facts", async () => {
    const current = evidenceFixture(); const source = current.packet.sources[0]; const oldText = source.text.replace("null", "true"); const hash = sha256Bytes(oldText);
    const previous = rebind({ ...current, originMainSha: "b".repeat(40), packet: { ...current.packet,
      sources: [{ ...source, evidenceId: `source:${hash}`, contentSha256: hash, snippetSha256: hash, text: oldText }],
      facts: [{ ...current.packet.facts[0], contentSha256: canonicalJsonSha256({ path: source.path, contentSha256: hash }), evidenceIds: [`source:${hash}`] }] } });
    const invoke = vi.fn(pair(current)[0].invoke);
    const result = await assessStewardshipIssue({ ...options(current), seats: pair(current).map((seat) => ({ ...seat, invoke })),
      holds: { Priority: { kind: "operator", value: "P2", frontier: current.packet.fieldHistory.Priority.frontier, at: "2026-09-22T12:00:00Z", materialEvidenceSha256: previous.packet.materialEvidenceSha256 } },
      heldEvidence: { [previous.packet.materialEvidenceSha256]: previous } });
    expect(result.status).toBe("assessed"); expect(invoke.mock.calls[0][0]).toEqual({ ...invoke.mock.calls[1][0], reserve: expect.any(Function), recordUsage: expect.any(Function) });
    expect(invoke.mock.calls[0][0].prompt).toContain(oldText.trim());
    expect(invoke.mock.calls[0][0].prompt).toContain(current.packet.facts[0].factId);
  });
});


describe("seat-owned reservation timing", () => {
  it.each([100_000, 500_000])("returns the turn timeout clamped at reservation after startup with %s ms initially left", async (remaining) => {
    const value = options(); let clock = Date.parse(now); let turnTimeoutMs: number | undefined;
    const startupMs = 50_000;
    const invoke = vi.fn(async ({ reserve }: SeatInput) => {
      clock += startupMs;
      turnTimeoutMs = reserve();
      return { assessment: assessmentFixture(), observedModel: "fixture" };
    });
    const result = await assessStewardshipIssue({ ...value, now: () => new Date(clock).toISOString(),
      deadlineAt: new Date(Date.parse(now) + remaining).toISOString(), seats: [{ ...value.seats[0], invoke }, value.seats[1]] });
    expect(result.status).toBe("assessed");
    expect(invoke.mock.calls[0][0].timeoutMs).toBe(Math.min(policy.limits.assessmentTimeoutMs, remaining));
    expect(turnTimeoutMs).toBe(Math.min(policy.limits.assessmentTimeoutMs, remaining - startupMs));
    expect(value.reserveCall).toHaveBeenCalledTimes(2);
  });

  it("journals exactly one assessment-started reservation for each attempt", async () => {
    const root = mkdtempSync(join(tmpdir(), "seat-reservation-once-"));
    const location = { root, repository: policy.repository, policy };
    const store = await acquireStewardshipStore({ ...location, owner: "test", initialize: { adoptionId: "once", at: now, census: { complete: true, issues: [] } } });
    try {
      store.append({ type: "run-started", runId: "run" }, now);
      const value = options();
      const invoke = vi.fn(value.seats[0].invoke).mockImplementationOnce(async ({ reserve }) => {
        reserve(); throw new StewardshipAssessmentError({ stage: "transport", code: "assessment_timeout", field: "$" });
      });
      const result = await assessStewardshipIssue({ ...value, seats: [{ ...value.seats[0], invoke }, value.seats[1]],
        reserveCall: (attempt) => { store.append({ type: "assessment-started", runId: "run", attempt }, now); } });
      expect(result.status).toBe("assessed"); expect(store.state.runs.run.assessmentCalls).toBe(3);
      const events = readFileSync(stewardshipPaths(location).journal, "utf8").trim().split("\n")
        .map((line) => JSON.parse(line).event).filter((event) => event.type === "assessment-started");
      expect(events.map((event) => event.attempt)).toEqual([1, 1, 2]);
    } finally { store.release(); rmSync(root, { recursive: true, force: true }); }
  });
  it.each([false, true])("fails closed when reserve is called twice (seat swallows refusal=%s)", async (swallow) => {
    const value = options();
    const invoke = vi.fn(async ({ reserve }: SeatInput) => {
      reserve();
      if (swallow) { try { reserve(); } catch {} } else reserve();
      return { assessment: assessmentFixture(), observedModel: "fixture" };
    });
    const result = await assessStewardshipIssue({ ...value, seats: [{ ...value.seats[0], invoke }, value.seats[1]] });
    expect(result).toMatchObject({ status: "deferred", reason: "assessment_failed", diagnostics: [
      { seat: "anthropic", stage: "reservation", code: "refused", field: "$" },
    ] });
    expect(result.assessments.map((entry) => entry.envelope.seat.family)).toEqual(["glm"]);
    expect(value.reserveCall).toHaveBeenCalledTimes(2); expect(invoke).toHaveBeenCalledOnce();
  });
  it("discards an otherwise valid answer when the seat never reserves", async () => {
    const value = options();
    const invoke = vi.fn(async (_input: SeatInput) => ({ assessment: assessmentFixture(), observedModel: "fixture" }));
    const result = await assessStewardshipIssue({ ...value, seats: value.seats.map((seat) => ({ ...seat, invoke })) });
    expect(result).toMatchObject({ status: "deferred", reason: "assessment_failed", assessments: [] });
    expect(result.diagnostics).toEqual(value.seats.map((seat) => ({ seat: seat.family, stage: "reservation", code: "refused", field: "$" })));
    expect(value.reserveCall).not.toHaveBeenCalled(); expect(value.archive).toHaveBeenCalledOnce();
  });
  it.each([false, true])("maps call_budget inside reserve without seat diagnostics (swallowed=%s)", async (swallow) => {
    const value = options(); const refusal = new StewardshipReservationRefusal("call_budget", "private-budget-message");
    const reserveCall = vi.fn(() => { throw refusal; }); const second = vi.fn(value.seats[1].invoke);
    const invoke = vi.fn(async ({ reserve }: SeatInput) => {
      if (swallow) { try { reserve(); } catch {} } else reserve();
      return { assessment: assessmentFixture(), observedModel: "fixture" };
    });
    const result = await assessStewardshipIssue({ ...value, reserveCall, seats: [{ ...value.seats[0], invoke }, { ...value.seats[1], invoke: second }] });
    expect(result).toMatchObject({ status: "deferred", reason: "call_budget_exhausted", assessments: [], diagnostics: [] });
    expect(reserveCall).toHaveBeenCalledOnce(); expect(invoke).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
  });
  it.each(["seat_unavailable", "seat_startup_timeout"] as const)("defers %s without reservation, retry or the remaining seat", async (code) => {
    const value = options(); const second = vi.fn(value.seats[1].invoke);
    const start = vi.fn(async (_timeoutMs: number, _runRemainingMs?: () => number) => { throw new StewardshipAssessmentError({ stage: "startup", code, field: "$" }); });
    const invoke = vi.fn(value.seats[0].invoke);
    const result = await assessStewardshipIssue({ ...value, seats: [{ ...value.seats[0], start, invoke }, { ...value.seats[1], invoke: second }] });
    expect(result).toMatchObject({ status: "deferred", reason: "seat_unavailable", assessments: [], diagnostics: [
      { seat: "anthropic", stage: "startup", code, field: "$" },
    ] });
    expect(() => stewardshipEventSchema.parse({ type: "assessment-rejected", ...result.diagnostics[0], contentSha256: "a".repeat(64) })).not.toThrow();
    expect(value.reserveCall).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledExactlyOnceWith(STEWARDSHIP_SEAT_STARTUP_MS, expect.any(Function));
    // The callback reports the run time left when the seat calls it, not when the host did.
    expect(start.mock.calls[0][1]?.()).toBe(Date.parse(value.deadlineAt) - Date.parse(now));
  });
  it("passes the run-time callback to every invoke and defers a pre-reservation deadline as assessment_deadline", async () => {
    const value = options(); const left = Date.parse(value.deadlineAt) - Date.parse(now); const seen: (number | undefined)[] = [];
    const invoke = vi.fn(async (input: SeatInput) => {
      seen.push(input.runRemainingMs?.());
      throw new StewardshipAssessmentError({ stage: "startup", code: "assessment_deadline", field: "$" });
    });
    const second = vi.fn(async (input: SeatInput) => { seen.push(input.runRemainingMs?.()); return value.seats[1].invoke(input); });
    const result = await assessStewardshipIssue({ ...value, seats: [{ ...value.seats[0], invoke }, { ...value.seats[1], invoke: second }] });
    expect(result).toMatchObject({ status: "deferred", reason: "assessment_deadline",
      diagnostics: [{ seat: "anthropic", stage: "startup", code: "assessment_deadline", field: "$" }] });
    expect(seen).toEqual([left, left]); expect(invoke).toHaveBeenCalledOnce();
  });
  it("rechecks an expired deadline after startup before reserving", async () => {
    const value = options(); let clock = Date.parse(now); const second = vi.fn(value.seats[1].invoke);
    const invoke = vi.fn(async ({ reserve }: SeatInput) => {
      clock = Date.parse(value.deadlineAt); reserve();
      return { assessment: assessmentFixture(), observedModel: "fixture" };
    });
    const result = await assessStewardshipIssue({ ...value, now: () => new Date(clock).toISOString(),
      seats: [{ ...value.seats[0], invoke }, { ...value.seats[1], invoke: second }] });
    expect(result).toMatchObject({ status: "deferred", reason: "assessment_deadline", assessments: [], diagnostics: [] });
    expect(value.reserveCall).not.toHaveBeenCalled(); expect(second).not.toHaveBeenCalled();
  });
  it("requires a full timeout plus startup budget before admitting a retry", async () => {
    const value = options(); let clock = Date.parse(now);
    const invoke = vi.fn(value.seats[0].invoke).mockImplementationOnce(async ({ reserve }) => {
      reserve(); clock = Date.parse(value.deadlineAt) - policy.limits.assessmentTimeoutMs - STEWARDSHIP_SEAT_STARTUP_MS + 1;
      throw new StewardshipAssessmentError({ stage: "transport", code: "assessment_timeout", field: "$" });
    });
    const result = await assessStewardshipIssue({ ...value, now: () => new Date(clock).toISOString(), seats: [{ ...value.seats[0], invoke }, value.seats[1]] });
    expect(result.reason).toBe("assessment_timeout"); expect(invoke).toHaveBeenCalledOnce(); expect(value.reserveCall).toHaveBeenCalledTimes(2);
  });
  it("rechecks the full per-call timeout at retry reservation after startup", async () => {
    const value = options(); let clock = Date.parse(now); let calls = 0;
    const invoke = vi.fn(async ({ reserve }: SeatInput) => {
      if (++calls === 1) {
        reserve(); clock = Date.parse(value.deadlineAt) - policy.limits.assessmentTimeoutMs - STEWARDSHIP_SEAT_STARTUP_MS;
        throw new StewardshipAssessmentError({ stage: "transport", code: "assessment_timeout", field: "$" });
      }
      clock += STEWARDSHIP_SEAT_STARTUP_MS + 1; reserve();
      return { assessment: assessmentFixture(), observedModel: "fixture" };
    });
    const result = await assessStewardshipIssue({ ...value, now: () => new Date(clock).toISOString(), seats: [{ ...value.seats[0], invoke }, value.seats[1]] });
    expect(result.reason).toBe("assessment_timeout"); expect(invoke).toHaveBeenCalledTimes(2); expect(value.reserveCall).toHaveBeenCalledTimes(2);
    expect(result.diagnostics).toEqual([{ seat: "anthropic", stage: "transport", code: "assessment_timeout", field: "$" }]);
  });
});
