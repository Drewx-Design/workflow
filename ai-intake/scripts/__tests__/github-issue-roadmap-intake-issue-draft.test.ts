import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseCriteria } from "../lib/easy-issue-autopilot/criteria";
import { parseIntakeAssessment, type IntakeMatchResult } from "../lib/github-issue-roadmap/intake-assessment";
import { compileIntakeDecision, type IntakeDecision } from "../lib/github-issue-roadmap/intake-decision";
import {
  buildCreateIssuePayload,
  buildEvidenceCommentBody,
  buildIntakeIssueDraft,
  buildIssueFieldValuePayload,
  intakeIntendedAction,
  INTAKE_CLASSIFICATION_ACTIONS,
  type IntakeIntendedAction,
} from "../lib/github-issue-roadmap/intake-issue-draft";
import { parseSourceMarker, SOURCE_MARKER, SOURCE_MARKER_LINE_COUNT } from "../lib/github-issue-roadmap/source-marker";
import { markerBlocks } from "../lib/github-issue-roadmap/intake-snapshot";
import { OUTCOME_ENVELOPE_SCHEMA_VERSION_V2, createOutcomeEnvelope, type OutcomeCandidate } from "../lib/github-issue-roadmap/outcome-candidate";
import { AUTHORED_START_COMMANDS, type AuthoredStartCommand } from "../lib/github-issue-roadmap/start-command-values";
import { buildIntakeStack, censusIssue, censusPass, markerBlock, stackEnvelope, stackSnapshot } from "./__helpers__/roadmap-intake-stack";

/** `censusIssue`'s default number: the issue that already carries the candidate's marker. */
const CANONICAL_ISSUE_NUMBER = 7;

/**
 * A stack whose canonical issue #7 already carries this candidate's marker for a *different*
 * emission: the outcome is consumed, so the artifact is an additive comment on #7, not a new issue.
 */
function exactMatchStack() {
  const envelope = stackEnvelope();
  const marker = markerBlock(envelope, envelope.candidates[0], "d".repeat(64));
  return buildIntakeStack({
    envelope,
    issues: [censusIssue({ body: ["Existing outcome body", "", marker].join("\n") })],
  });
}

function draftFor(capabilities?: readonly string[] | null) {
  const stack = buildIntakeStack(capabilities === undefined ? {} : { capabilities });
  return {
    stack,
    draft: buildIntakeIssueDraft({
      envelope: stack.envelope,
      candidate: stack.envelope.candidates[0],
      decision: stack.decision,
    }),
  };
}

function taskDraftFor(capabilities?: readonly string[] | null) {
  const envelope = stackEnvelope(1, {}, {
    type: { value: "Task", confidence: "high", rationale: "Bounded task." },
  });
  const base = buildIntakeStack({ envelope, ...(capabilities === undefined ? {} : { capabilities }) });
  const assessment = parseIntakeAssessment({
    ...base.assessment,
    candidates: base.assessment.candidates.map((entry) => ({
      ...entry,
      classification: { ...entry.classification, type: { ...entry.classification.type, value: "Task", rationale: "Bounded task." } },
    })),
  }, envelope, base.snapshot, undefined, new Map());
  const decision = compileIntakeDecision({ dispositionHistory: new Map(),
    envelope, snapshot: base.snapshot, assessment, capabilityManifest: base.capabilityManifest,
    existenceRecord: base.existenceRecord, verifiedOriginMainSha: base.existenceRecord.originMainSha,
  });
  const stack = { ...base, assessment, decision };
  return {
    stack,
    draft: buildIntakeIssueDraft({ envelope, candidate: envelope.candidates[0], decision }),
  };
}

// Documented copy of scripts/lib/github-issue-roadmap/stewardship-evidence.ts:644-659.
function completionRuleFromBody(body: string): string {
  const lines = body.split(/\r?\n/);
  const preferred = lines.findIndex((line) => /^#{1,6}\s+(?:completion|definition of done|acceptance criteria)\b/i.test(line));
  const fallback = preferred < 0;
  const heading = preferred >= 0 ? preferred : lines.findIndex((line) => /^##\s+Outcome\b/i.test(line));
  if (heading < 0) return "";
  const selected: string[] = [];
  for (let index = heading + 1; index < lines.length && selected.length < 24; index += 1) {
    if (/^#{1,6}\s+/.test(lines[index])) break;
    const value = lines[index].replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim();
    // Filing renders the Outcome as one paragraph; its unheaded intake commentary follows a blank line.
    if (fallback && !value && selected.length > 0) break;
    if (value) selected.push(value);
  }
  return selected.join("\n");
}

describe("authored acceptance criteria", () => {
  const criteria = [
    "The filed issue preserves `authored text` and **emphasis**.",
    "Auto-fix returns each item in authored order; repeated  spaces remain.",
    "The sorter reads exactly these three criteria.",
  ];

  function render(input: {
    readonly acceptanceCriteria?: readonly string[];
    readonly completionRule?: string;
    readonly satisfiedClauses?: readonly string[];
    readonly rationale?: string;
    readonly schemaVersion?: 1 | 2;
    readonly append?: boolean;
  } = {}) {
    const raw = JSON.parse(JSON.stringify(stackEnvelope()));
    raw.schemaVersion = raw.schemaVersion.replace(/v1$/, `v${input.schemaVersion ?? 2}`);
    for (const entry of raw.candidates) {
      delete entry.sourceFingerprint;
      delete entry.emissionContentSha256;
    }
    if (input.acceptanceCriteria !== undefined) raw.candidates[0].acceptanceCriteria = input.acceptanceCriteria;
    if (input.completionRule !== undefined) raw.candidates[0].outcome.completionRule = input.completionRule;
    const envelope = createOutcomeEnvelope(raw);
    const stack = buildIntakeStack({ envelope, ...(input.append ? {
      issues: [censusIssue({ body: markerBlock(envelope, envelope.candidates[0], "d".repeat(64)) })],
    } : {}) });
    const decision = JSON.parse(JSON.stringify(stack.decision));
    if (input.satisfiedClauses !== undefined) {
      decision.candidates[0].existenceOutcome = {
        kind: "partial_released_unqualified",
        satisfiedClauses: input.satisfiedClauses,
      };
    }
    if (input.rationale !== undefined) {
      for (const action of decision.candidates[0].actions) {
        if (action.action === "create_issue") action.rationale = input.rationale;
      }
    }
    // Envelope parsing trims whitespace; exercise the renderer with the original Outcome line.
    const candidate = input.completionRule === undefined ? envelope.candidates[0] : {
      ...envelope.candidates[0],
      outcome: { ...envelope.candidates[0].outcome, completionRule: input.completionRule },
    };
    return buildIntakeIssueDraft({ ...stack, candidate, decision });
  }

  it("pins the copied sorter completion reader to its source text", () => {
    const sourcePattern = /^function completionRuleFromBody\(body: string\): string \{[\s\S]*?^\}/m;
    const sorterSource = readFileSync(new URL("../lib/github-issue-roadmap/stewardship-evidence.ts", import.meta.url), "utf8");
    const testSource = readFileSync(new URL("./github-issue-roadmap-intake-issue-draft.test.ts", import.meta.url), "utf8");
    const realFunction = sorterSource.match(sourcePattern)?.[0];
    const copiedFunction = testSource.match(sourcePattern)?.[0];
    expect(realFunction).toBeDefined();
    expect(copiedFunction).toBeDefined();
    expect(copiedFunction?.replace(/\s+/g, " ").trim()).toBe(realFunction?.replace(/\s+/g, " ").trim());
  });

  it("lets the sorter prefer authored criteria over the Outcome fallback", () => {
    const { body } = render({ acceptanceCriteria: criteria, rationale: "File the remaining outcome.",
      satisfiedClauses: ["An existing clause is already satisfied."] }).issue;
    expect(body.startsWith("## Outcome\n")).toBe(true);
    expect(completionRuleFromBody(body).split("\n")).toEqual(criteria);
    expect(parseCriteria(body)).toEqual(criteria);
  });

  it("leaves the sorter its Outcome fallback when no criteria are authored", () => {
    const { body } = render().issue;
    const lines = body.split("\n");
    expect(lines[0]).toBe("## Outcome");
    expect(body).not.toContain("## Acceptance criteria");
    // The fallback reads only the Outcome prose; it stops at the blank line before any intake commentary.
    expect(completionRuleFromBody(body).split("\n")[0]).toBe(lines[1]);
    expect(parseCriteria(body)).toEqual([]);
  });

  it("keeps intake rationale and partial-existence lines out of the Outcome fallback", () => {
    const { body } = render({ rationale: "File the remaining outcome.",
      satisfiedClauses: ["An existing clause is already satisfied."] }).issue;
    const lines = body.split("\n");
    expect(body).toContain("Intake rationale: File the remaining outcome.");
    expect(body).toContain("Filed on a partial existence verdict.");
    expect(completionRuleFromBody(body)).toBe(lines[1].trim());
  });

  const markdownCompletionRules = [
    "## Acceptance criteria",
    "# Completion: tests pass",
    "```ts fenced example",
    "~~~ x",
    "   ## indented heading",
  ];

  it.each(markdownCompletionRules)("escapes Outcome markers above authored criteria: %j", (completionRule) => {
    const { body } = render({ acceptanceCriteria: criteria, completionRule }).issue;
    expect(body.split("\n")[1]).toBe(`\\${completionRule.trimStart()}`);
    expect(parseCriteria(body)).toEqual(criteria);
    expect(completionRuleFromBody(body).split("\n")).toEqual(criteria);
  });

  it.each(markdownCompletionRules)("escapes Outcome markers without criteria while preserving the remaining body: %j", (completionRule) => {
    const draft = render({ completionRule, satisfiedClauses: ["An existing clause is already satisfied."],
      rationale: "File the remaining outcome." });
    // Escape the Outcome marker while preserving the current Assessment disclosure and remaining body.
    expect(draft.issue.body).toBe(`## Outcome
\\${completionRule.trimStart()}

Filed on a partial existence verdict. The probe scored these clauses as already satisfied on origin/main:
- An existing clause is already satisfied.

Intake rationale: File the remaining outcome.

## Assessment
Verdict: clearly_novel (confidence high)
Intended classification: Type Feature \u00b7 Priority none \u00b7 Effort Medium
Rationale: File the remaining outcome.
Evidence coverage: unknown (no evidence-view record)

## Evidence and provenance
- current_main_verification: scripts/github-issue-roadmap-intake.ts (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)
- approved_strategy: STRATEGY.md (bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)
- provenance: docs/plans/ai-managed-roadmap-intake.md (cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc)

${draft.marker}`);
  });

  it.each(["## Assessment", "# Completion: x", "```ts x", "~~~ x", " \t## Assessment"])(
    "keeps the real Assessment readable with an Outcome marker and no criteria: %j", (completionRule) => {
      const { body } = render({ completionRule }).issue;
      expect(body.split("\n")[1]).toBe(`\\${completionRule.trimStart()}`);
      // Copy of the Assessment-section split in scripts/lib/github-issue-roadmap/stewardship-projection.ts:190.
      const assessmentSection = body.split(/^## Assessment\s*\r?$/m)[1]?.split(/^## /m)[0];
      expect(assessmentSection).toContain("Intended classification: Type Feature \u00b7 Priority none \u00b7 Effort Medium");
    },
  );

  it("round-trips exactly the authored bullets through both completion readers", () => {
    const draft = render({ acceptanceCriteria: criteria,
      satisfiedClauses: ["An existing clause is already satisfied.", "Another existing clause is already satisfied."],
      rationale: "File the remaining outcome with its authored criteria." });
    const { body } = draft.issue;
    const lines = body.split("\n");
    const heading = lines.indexOf("## Acceptance criteria");
    expect(body).toMatch(/^## Outcome\n[^\n]+\n\n## Acceptance criteria\n/);
    expect(lines[heading]).toMatch(/^#{1,6}\s+(?:completion|definition of done|acceptance criteria)\b/i);
    expect(lines.slice(heading + 1, heading + 1 + criteria.length)).toEqual(criteria.map((item) => `- ${item}`));
    expect(lines[heading + 1 + criteria.length]).toBe("");
    const nextLine = lines.slice(heading + 1 + criteria.length).find((line) => line.trim() !== "");
    expect(nextLine).toBe("## Intake notes");
    expect(nextLine).toMatch(/^## /);
    expect(body).toContain("\n- An existing clause is already satisfied.\n- Another existing clause is already satisfied.\n");
    expect(body).toContain("Intake rationale: File the remaining outcome with its authored criteria.");
    expect(parseCriteria(body)).toEqual(criteria);
    expect(completionRuleFromBody(body).split("\n")).toEqual(criteria);
    expect(markerBlocks(body)).toEqual([{ raw: draft.marker, modified: false }]);
    expect(parseSourceMarker(markerBlocks(body)[0].raw)).toEqual(parseSourceMarker(draft.marker));
    expect(body.endsWith(draft.marker)).toBe(true);
  });

  it("closes criteria with Assessment when there are no intake notes", () => {
    const draft = render({ acceptanceCriteria: criteria, append: true });
    const { body } = draft.issue;
    expect(draft.intendedAction).toBe("append_evidence");
    expect(body).not.toContain("## Intake notes");
    expect(body).toContain(`- ${criteria.at(-1)}\n\n## Assessment\n`);
    expect(parseCriteria(body)).toEqual(criteria);
    expect(completionRuleFromBody(body).split("\n")).toEqual(criteria);
  });

  it("preserves the body outside Assessment when criteria are omitted", () => {
    const draft = render({ satisfiedClauses: ["An existing clause is already satisfied."],
      rationale: "File the remaining outcome." });
    // Captured at fd7ace3e029c3769d8b91c1195c83a11730fd60c, with updated Assessment disclosure.
    expect(draft.issue.body).toBe(`## Outcome
Every registered producer emits a valid envelope.

Filed on a partial existence verdict. The probe scored these clauses as already satisfied on origin/main:
- An existing clause is already satisfied.

Intake rationale: File the remaining outcome.

## Assessment
Verdict: clearly_novel (confidence high)
Intended classification: Type Feature \u00b7 Priority none \u00b7 Effort Medium
Rationale: File the remaining outcome.
Evidence coverage: unknown (no evidence-view record)

## Evidence and provenance
- current_main_verification: scripts/github-issue-roadmap-intake.ts (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)
- approved_strategy: STRATEGY.md (bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)
- provenance: docs/plans/ai-managed-roadmap-intake.md (cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc)

<!-- github-issue-roadmap-source:v1 -->
source-fingerprint: 76a3a89677435852927a4eb60644a3414eaaa123f8e387a354172503d83774d2
emission-content-sha256: ef132ee470f1d964ff4bf3312fe487e17be20f1dabf35056ea5066444f5dcf88
producer-kind: plan
producer-version: 1
stable-artifact-id: plan:ai-managed-roadmap-intake
stable-outcome-id: shared-outcome-1
source-locator: docs/plans/ai-managed-roadmap-intake.md`);
    expect(draft.issue.body).not.toContain("## Intake notes");
    expect(draft.issue.body).not.toContain("Acceptance criteria");
  });

  it("renders no criteria or intake-notes heading for a v1 candidate", () => {
    const { body } = render({ schemaVersion: 1 }).issue;
    expect(body).not.toContain("Acceptance criteria");
    expect(body).not.toContain("## Intake notes");
  });

  it("preserves every criterion when oversized intake prose reaches the aggregate cap", () => {
    const draft = render({ acceptanceCriteria: criteria,
      satisfiedClauses: Array.from({ length: 8 }, (_, index) => `Satisfied clause ${index}: ${"x".repeat(8_000)}`),
      rationale: "r".repeat(8_000) });
    const { body } = draft.issue;
    expect(body.length).toBe(24_576 + 2 + draft.marker.length);
    expect(parseCriteria(body)).toEqual(criteria);
    expect(completionRuleFromBody(body).split("\n")).toEqual(criteria);
    for (const item of criteria) expect(body).toContain(`\n- ${item}\n`);
    expect(body.slice(body.indexOf(`- ${criteria.at(-1)}`) + `- ${criteria.at(-1)}`.length)
      .split("\n").find((line) => line.trim() !== "")).toMatch(/^## /);
    expect(markerBlocks(body)).toEqual([{ raw: draft.marker, modified: false }]);
    expect(parseSourceMarker(markerBlocks(body)[0].raw)).toEqual(parseSourceMarker(draft.marker));
    expect(body.endsWith(draft.marker)).toBe(true);
  });
});

describe("authored Start commands", () => {
  function startStack(startCommand?: AuthoredStartCommand) {
    const base = stackEnvelope();
    const envelope = createOutcomeEnvelope({
      ...base,
      schemaVersion: OUTCOME_ENVELOPE_SCHEMA_VERSION_V2,
      candidates: base.candidates.map(({ sourceFingerprint: _fingerprint, emissionContentSha256: _emission, ...material }) => ({
        ...material, ...(startCommand === undefined ? {} : { startCommand }),
      })),
    });
    return buildIntakeStack({ envelope });
  }

  function classificationLine(body: string): string | undefined {
    return body.split("\n").find((line) => line.startsWith("Intended classification:"));
  }

  it.each(AUTHORED_START_COMMANDS)("appends the authored %s to the classification line", (startCommand) => {
    const stack = startStack(startCommand);
    const draft = buildIntakeIssueDraft({ ...stack, candidate: stack.envelope.candidates[0] });
    expect(classificationLine(draft.issue.body)).toBe(
      `Intended classification: Type Feature \u00b7 Priority none \u00b7 Effort Medium \u00b7 Start ${startCommand}`,
    );
  });

  // Documented copy of the sorter's classification parser after Start command plan U6
  // (scripts/lib/github-issue-roadmap/stewardship-projection.ts, `classificationPattern`, #2272).
  // The pin below binds this copy to that source text, so the round trip proves the real reader.
  const SORTER_CLASSIFICATION_PATTERN = /^Intended classification: Type (Bug|Feature|Task|none) · Priority (P[0-3]|none) · Effort (Low|Medium|High|none)(?: · Start (\S+))?$/;

  it("pins the copied sorter classification parser to its source text", () => {
    const sorterSource = readFileSync(new URL("../lib/github-issue-roadmap/stewardship-projection.ts", import.meta.url), "utf8");
    // Anchored to a declaration line and unique, so a stale comment cannot stand in for the parser.
    const declarations = [...sorterSource.matchAll(/^\s*const classificationPattern = \/(.+)\/;\r?$/gm)];
    expect(declarations).toHaveLength(1);
    const literal = declarations[0]?.[1];
    expect(literal).toBe(SORTER_CLASSIFICATION_PATTERN.source);
  });

  it.each(AUTHORED_START_COMMANDS)("AE1: the sorter's parser reads the authored %s back from a filed body", (startCommand) => {
    const stack = startStack(startCommand);
    const draft = buildIntakeIssueDraft({ ...stack, candidate: stack.envelope.candidates[0] });
    const match = SORTER_CLASSIFICATION_PATTERN.exec(classificationLine(draft.issue.body) ?? "");
    expect(match?.slice(1)).toEqual(["Feature", "none", "Medium", startCommand]);
  });

  it("leaves the sorter's parser reading no Start when none is authored", () => {
    const stack = startStack();
    const draft = buildIntakeIssueDraft({ ...stack, candidate: stack.envelope.candidates[0] });
    const match = SORTER_CLASSIFICATION_PATTERN.exec(classificationLine(draft.issue.body) ?? "");
    expect(match?.slice(1)).toEqual(["Feature", "none", "Medium", undefined]);
  });

  it("preserves the current body bytes when Start is absent or undefined", () => {
    const stack = startStack();
    const decision = { ...stack.decision, candidates: stack.decision.candidates.map((entry) => ({
      ...entry,
      actions: entry.actions.map((action) => action.action === "create_issue"
        ? { ...action, rationale: "File the remaining outcome." } : action),
    })) };
    const candidate = stack.envelope.candidates[0];
    const draft = buildIntakeIssueDraft({ ...stack, decision, candidate });
    // Captured from the base renderer before adding Start command support.
    const expectedBody = `## Outcome
Every registered producer emits a valid envelope.

Intake rationale: File the remaining outcome.

## Assessment
Verdict: clearly_novel (confidence high)
Intended classification: Type Feature \u00b7 Priority none \u00b7 Effort Medium
Rationale: File the remaining outcome.
Evidence coverage: unknown (no evidence-view record)

## Evidence and provenance
- current_main_verification: scripts/github-issue-roadmap-intake.ts (aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)
- approved_strategy: STRATEGY.md (bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb)
- provenance: docs/plans/ai-managed-roadmap-intake.md (cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc)

<!-- github-issue-roadmap-source:v1 -->
source-fingerprint: 76a3a89677435852927a4eb60644a3414eaaa123f8e387a354172503d83774d2
emission-content-sha256: ef132ee470f1d964ff4bf3312fe487e17be20f1dabf35056ea5066444f5dcf88
producer-kind: plan
producer-version: 1
stable-artifact-id: plan:ai-managed-roadmap-intake
stable-outcome-id: shared-outcome-1
source-locator: docs/plans/ai-managed-roadmap-intake.md`;
    expect(Buffer.from(draft.issue.body)).toEqual(Buffer.from(expectedBody));
    expect(classificationLine(draft.issue.body)).not.toContain("Start");
    const explicitUndefined = buildIntakeIssueDraft({ ...stack, decision, candidate: { ...candidate, startCommand: undefined } });
    expect(Buffer.from(explicitUndefined.issue.body)).toEqual(Buffer.from(expectedBody));
  });

  it("keeps shadow and enabled drafts aligned for an authored Start command", () => {
    const stack = startStack("ce-debug");
    const input = { ...stack, candidate: stack.envelope.candidates[0] };
    const shadow = buildIntakeIssueDraft({
      ...input, assessmentMatch: stack.assessment.candidates[0].match,
      evidenceCoverage: { bodiesIncluded: 1, bodiesOmitted: 2, attentionRequestsOutsideView: [], citationsOutsideView: [] },
    });
    const enabled = buildIntakeIssueDraft(input);
    expect(classificationLine(shadow.issue.body)).toBe(
      "Intended classification: Type Feature \u00b7 Priority none \u00b7 Effort Medium \u00b7 Start ce-debug",
    );
    expect(classificationLine(enabled.issue.body)).toBe(classificationLine(shadow.issue.body));
  });

  it.each(["ce-resolve-pr-feedback", "none", "", null, "ce-prototype"])(
    "rejects an out-of-set candidate Start command %j at the renderer", (startCommand) => {
      const stack = startStack();
      const candidate = { ...stack.envelope.candidates[0], startCommand } as OutcomeCandidate;
      expect(() => buildIntakeIssueDraft({ ...stack, candidate })).toThrow(/Invalid Start command value/);
    },
  );
});

describe("intended classification and possible overlap", () => {
  function classifiedStack(
    type: "Bug" | "Feature" | "Task" | null,
    priority: "P0" | "P1" | "P2" | "P3",
    envelope = stackEnvelope(),
  ) {
    const stack = buildIntakeStack({ envelope });
    const assessment = parseIntakeAssessment({
      ...stack.assessment,
      candidates: stack.assessment.candidates.map((entry) => ({
        ...entry,
        classification: {
          ...entry.classification,
          type: { ...entry.classification.type, value: type },
          priority: { ...entry.classification.priority, value: priority },
          effort: { ...entry.classification.effort, value: "Medium" },
        },
      })),
    }, envelope, stack.snapshot, undefined, new Map());
    const decision = compileIntakeDecision({ dispositionHistory: new Map(),
      ...stack, assessment, verifiedOriginMainSha: stack.decision.verifiedOriginMainSha,
    });
    return { ...stack, assessment, decision };
  }

  it.each([
    { type: "Feature", priority: "P3", intendedPriority: "none" },
    { type: "Bug", priority: "P1", intendedPriority: "P1" },
    { type: null, priority: "P2", intendedPriority: "none" },
    { type: null, priority: "P0", intendedPriority: "P0" },
  ] as const)("renders compiled intent for Type $type and assessed Priority $priority", ({ type, priority, intendedPriority }) => {
    const stack = classifiedStack(type, priority);
    const draft = buildIntakeIssueDraft({ ...stack, candidate: stack.envelope.candidates[0] });
    const expected = `Intended classification: Type ${type ?? "none"} \u00b7 Priority ${intendedPriority} \u00b7 Effort Medium`;
    const lines = draft.issue.body.split("\n");
    const verdict = lines.findIndex((line) => line.startsWith("Verdict:"));
    expect(lines[verdict + 1]).toBe(expected);
    expect(draft.issue.body).toMatch(/^Intended classification: Type (Bug|Feature|Task|none) \u00b7 Priority (P[0-3]|none) \u00b7 Effort (Low|Medium|High|none)$/m);
    const priorityAction = stack.decision.candidates[0].actions.find(({ action }) => action === "set_priority");
    if (intendedPriority === "none") expect(priorityAction).toBeUndefined();
    else expect(priorityAction).toMatchObject({ proposed: priority, disposition: "approval_required" });
  });

  it.each(["automatic_safe", "recommendation_only", "approval_required", "hold_no_write"] as const)(
    "includes compiled classifications with disposition %s", (disposition) => {
      const { stack } = taskDraftFor();
      const decision = { ...stack.decision, candidates: stack.decision.candidates.map((entry) => ({
        ...entry,
        actions: entry.actions.map((action) => INTAKE_CLASSIFICATION_ACTIONS.some((kind) => kind === action.action)
          ? { ...action, disposition } : action),
      })) };
      const draft = buildIntakeIssueDraft({ ...stack, decision, candidate: stack.envelope.candidates[0] });
      expect(draft.issue.body).toContain("Intended classification: Type Task \u00b7 Priority P2 \u00b7 Effort Medium");
    },
  );

  it("renders none for every absent compiled classification", () => {
    const stack = buildIntakeStack();
    const decision = { ...stack.decision, candidates: stack.decision.candidates.map((entry) => ({
      ...entry,
      actions: entry.actions.filter(({ action }) => !INTAKE_CLASSIFICATION_ACTIONS.some((kind) => kind === action)),
    })) };
    const draft = buildIntakeIssueDraft({ ...stack, decision, candidate: stack.envelope.candidates[0] });
    expect(draft.issue.body).toContain("Intended classification: Type none \u00b7 Priority none \u00b7 Effort none");
  });

  it.each(INTAKE_CLASSIFICATION_ACTIONS)("rejects duplicate %s actions", (kind) => {
    const { stack } = taskDraftFor();
    const decision = { ...stack.decision, candidates: stack.decision.candidates.map((entry) => ({
      ...entry, actions: [...entry.actions, entry.actions.find(({ action }) => action === kind)!],
    })) };
    expect(() => buildIntakeIssueDraft({ ...stack, decision, candidate: stack.envelope.candidates[0] }))
      .toThrow(`more than one ${kind} classification action`);
  });

  it.each([
    { kind: "set_priority", proposed: "P4", field: "Priority" },
    { kind: "set_type", proposed: "", field: "Type" },
    { kind: "set_effort", proposed: "Huge", field: "Effort" },
  ] as const)("rejects invalid $field classification value $proposed", ({ kind, proposed, field }) => {
    const { stack } = taskDraftFor();
    const decision = { ...stack.decision, candidates: stack.decision.candidates.map((entry) => ({
      ...entry,
      actions: entry.actions.map((action) => action.action === kind ? { ...action, proposed } : action),
    })) };
    expect(() => buildIntakeIssueDraft({ ...stack, decision, candidate: stack.envelope.candidates[0] }))
      .toThrow(`Invalid ${field} classification value ${JSON.stringify(proposed)}`);
  });

  it.each([
    { schemaVersion: 1, acceptanceCriteria: undefined },
    { schemaVersion: 2, acceptanceCriteria: undefined },
    { schemaVersion: 2, acceptanceCriteria: ["First authored criterion.", "Second authored criterion."] },
  ])("keeps shadow and enabled drafts aligned for v$schemaVersion with criteria $acceptanceCriteria", ({ schemaVersion, acceptanceCriteria }) => {
    const raw = JSON.parse(JSON.stringify(stackEnvelope()));
    raw.schemaVersion = raw.schemaVersion.replace(/v1$/, `v${schemaVersion}`);
    for (const entry of raw.candidates) {
      delete entry.sourceFingerprint;
      delete entry.emissionContentSha256;
    }
    if (acceptanceCriteria !== undefined) raw.candidates[0].acceptanceCriteria = acceptanceCriteria;
    const stack = classifiedStack("Feature", "P3", createOutcomeEnvelope(raw));
    const input = { ...stack, candidate: stack.envelope.candidates[0] };
    const shadow = buildIntakeIssueDraft({
      ...input, assessmentMatch: stack.assessment.candidates[0].match,
      evidenceCoverage: { bodiesIncluded: 1, bodiesOmitted: 2, attentionRequestsOutsideView: [], citationsOutsideView: [] },
    });
    const enabled = buildIntakeIssueDraft(input);
    const criteriaPattern = /^## Acceptance criteria\n[\s\S]*?(?=^## )/m;
    const shadowCriteria = shadow.issue.body.match(criteriaPattern)?.[0] ?? "";
    const enabledCriteria = enabled.issue.body.match(criteriaPattern)?.[0] ?? "";
    expect(Buffer.from(shadowCriteria)).toEqual(Buffer.from(enabledCriteria));
    expect(parseCriteria(shadow.issue.body)).toEqual(acceptanceCriteria ?? []);
    const classificationLine = (body: string) => body.split("\n").find((line) => line.startsWith("Intended classification:"))!;
    expect(classificationLine(shadow.issue.body)).toBe("Intended classification: Type Feature \u00b7 Priority none \u00b7 Effort Medium");
    expect(Buffer.from(classificationLine(shadow.issue.body))).toEqual(Buffer.from(classificationLine(enabled.issue.body)));
    expect(shadow.issue.body).not.toBe(enabled.issue.body);
  });

  it("names possible overlap without claiming a link", () => {
    const stack = buildIntakeStack({ match: () => "plausible_overlap" });
    const draft = buildIntakeIssueDraft({ ...stack, candidate: stack.envelope.candidates[0],
      assessmentMatch: { ...stack.assessment.candidates[0].match, competingIssueNumbers: [7] } });
    const overlap = draft.issue.body.split("\n").find((line) => line.startsWith("Possible overlap:"));
    expect(overlap).toBe("Possible overlap: #7");
    expect(overlap).not.toMatch(/linked|related/);
    expect(draft.issue.body).not.toContain("Competitors:");
  });

  it("omits overlap and competitors lines when there are no competing issues", () => {
    expect(draftFor().draft.issue.body).not.toMatch(/Possible overlap|Competitors/);
  });
});

describe("create issue forgery resistance", () => {
  function render(rationale: string) {
    const stack = buildIntakeStack();
    const candidate = stack.envelope.candidates[0];
    const marker = markerBlock(stack.envelope, candidate);
    const decision = {
      ...stack.decision,
      candidates: stack.decision.candidates.map((entry) => ({
        ...entry,
        actions: entry.actions.map((action) => action.action === "create_issue" ? { ...action, rationale } : action),
      })),
    };
    const payload = buildIntakeIssueDraft({ envelope: stack.envelope, candidate, decision }).issue;
    return { ...stack, candidate, marker, body: payload.body };
  }

  const sentinels = [SOURCE_MARKER, " \t<!--  GiThUb-IsSuE-RoAdMaP-SoUrCe:V27  -->  ", "<!--github-issue-roadmap-source-->"];
  it.each(sentinels)("neutralizes a standalone sentinel attack: %s", (sentinel) => {
    const { body, marker } = render(`Before\n${sentinel}\nAfter`);
    expect(markerBlocks(body)).toHaveLength(1);
    expect(markerBlocks(body)).toEqual([{ raw: marker, modified: false }]);
    expect(body.slice(0, body.indexOf(marker))).not.toMatch(/github-issue-roadmap-source/i);
  });

  it.each(["\n", "\r", "\v", "\f", "\u0085", "\u2028", "\u2029", "\u2028\u2029"])(
    "defeats a full forged span separated by %j even after Unicode newline normalization",
    (separator) => {
      const envelope = stackEnvelope();
      const candidate = envelope.candidates[0];
      const forgedFingerprint = "f".repeat(64);
      const forged = markerBlock(envelope, candidate).replace(candidate.sourceFingerprint, forgedFingerprint);
      for (const sentinel of sentinels) {
        const attack = `Before\n${forged.replace(SOURCE_MARKER, sentinel)}\nAfter`.replace(/\n/g, separator);
        const { body, marker } = render(attack);
        for (const normalized of [body, body.replace(/[\u2028\u2029]/g, "\n")]) {
          const blocks = markerBlocks(normalized);
          expect(blocks).toHaveLength(1);
          expect(blocks).toEqual([{ raw: marker, modified: false }]);
          const snapshot = stackSnapshot(envelope, censusPass([censusIssue({ body: normalized })]));
          expect(Object.keys(snapshot.markerIndex)).toEqual([candidate.sourceFingerprint]);
          expect(snapshot.markerIndex).not.toHaveProperty(forgedFingerprint);
          expect(snapshot.markerIncidents).toEqual([]);
        }
        expect(body.slice(0, body.indexOf(marker))).not.toMatch(/github-issue-roadmap-source/i);
        expect(body).not.toMatch(/[\r\v\f\u0085\u2028\u2029]/);
        expect(body).toContain("Before ");
      }
    },
  );

  it("truncates an oversized forgery attempt without cutting the real marker", () => {
    const { body, marker } = render(`prefix\u2028${"x".repeat(70_000)}\n${SOURCE_MARKER}\nforged tail`);
    const rationaleLine = body.split("\n").find((line) => line.includes("prefix"))!;
    const text = rationaleLine.replace(/^Intake rationale: /, "");
    expect(text).toHaveLength(4_096);
    expect(text).toMatch(/^prefix /);
    expect(text.endsWith("… [truncated]")).toBe(true);
    expect(body.length).toBeLessThan(65_536);
    expect(body.length).toBeLessThanOrEqual(24_576 + 2 + marker.length);
    expect(body.includes(marker)).toBe(true);
    expect(markerBlocks(body)).toHaveLength(1);
    expect(markerBlocks(body)).toEqual([{ raw: marker, modified: false }]);
    expect(parseSourceMarker(markerBlocks(body)[0].raw)).toEqual(parseSourceMarker(marker));
  });
});

describe("other free-text embed forgery attempts", () => {
  it("collapses NEL inside the sentinel before neutralizing it", () => {
    const envelope = stackEnvelope();
    const marker = markerBlock(envelope, envelope.candidates[0]);
    // Use the completion rule: it gets exactly one sanitization pass, so a second pass
    // cannot hide a reversed-order bug by removing the newly manufactured sentinel.
    const payload = buildCreateIssuePayload({ title: "Outcome", marker, evidenceLines: [],
      completionRule: "<!--\u0085github-issue-roadmap-source:v1\u0085-->",
    });
    const prose = payload.body.slice(0, payload.body.lastIndexOf(marker));
    expect(markerBlocks(prose)).toEqual([]);
    expect(markerBlocks(payload.body)).toEqual([{ raw: marker, modified: false }]);
    expect(prose).toContain("[source marker removed]");
  });

  it("neutralizes attacks in titles, completion rules, evidence, and provenance", () => {
    const envelope = stackEnvelope();
    const candidate = envelope.candidates[0];
    const marker = markerBlock(envelope, candidate);
    const attack = `\u2028${marker}\u2029`;
    const common = { title: attack, completionRule: attack, evidenceLines: [attack], marker };
    const tainted = { ...candidate,
      evidence: candidate.evidence.map((entry) => ({ ...entry, sourceLocator: attack })),
      provenance: candidate.provenance.map((entry) => ({ ...entry, sourceLocator: attack })),
    };
    const create = buildCreateIssuePayload(common);
    for (const title of [create.title]) {
      expect(title).not.toMatch(/github-issue-roadmap-source/i);
      expect(title).not.toMatch(/[\n\u2028\u2029]/);
    }
    for (const body of [create.body, buildEvidenceCommentBody(envelope, tainted)]) {
      expect(markerBlocks(body)).toHaveLength(1);
      expect(markerBlocks(body.replace(/[\u2028\u2029]/g, "\n"))).toEqual([{ raw: marker, modified: false }]);
      expect(body.slice(0, body.indexOf(marker))).not.toMatch(/github-issue-roadmap-source/i);
    }
  });

  it("bounds repeated oversized embeds while reserving the intact marker", () => {
    const envelope = stackEnvelope();
    const marker = markerBlock(envelope, envelope.candidates[0]);
    const attack = `x${SOURCE_MARKER}${"x".repeat(8_000)}`;
    const common = { title: "Outcome", completionRule: attack, marker, evidenceLines: Array(30).fill(attack) as string[] };
    for (const payload of [buildCreateIssuePayload(common)]) {
      expect(payload.body.length).toBe(24_576 + 2 + marker.length);
      expect(payload.body.length).toBeLessThan(65_536);
      expect(payload.body.endsWith(`… [truncated]\n\n${marker}`)).toBe(true);
      expect(markerBlocks(payload.body)).toEqual([{ raw: marker, modified: false }]);
    }
  });
});

describe("trusted marker sink checks", () => {
  function render(marker: string) {
    return buildCreateIssuePayload({ title: "Outcome", completionRule: "Done", marker, evidenceLines: [] });
  }

  it.each(["missing", "extra"])("rejects a marker with a %s line", (shape) => {
    const envelope = stackEnvelope();
    const marker = markerBlock(envelope, envelope.candidates[0]);
    const malformed = shape === "missing" ? marker.split("\n").slice(0, -1).join("\n") : `${marker}\nextra`;
    expect(() => render(malformed)).toThrow(`Source marker must contain exactly ${SOURCE_MARKER_LINE_COUNT} lines`);
  });

  it.each([SOURCE_MARKER, " \t<!-- GiThUb-IsSuE-RoAdMaP-SoUrCe:V27 --> ", "<!--github-issue-roadmap-source-->"])(
    "rejects a nested sentinel without relying on line-count validation: %s", (sentinel) => {
      const envelope = stackEnvelope();
      const lines = markerBlock(envelope, envelope.candidates[0]).split("\n");
      for (let index = 1; index < lines.length; index += 1) {
        const malformed = lines.map((line, lineIndex) => lineIndex === index ? sentinel : line).join("\n");
        expect(malformed.split("\n")).toHaveLength(SOURCE_MARKER_LINE_COUNT);
        expect(() => render(malformed)).toThrow("Source marker must not contain another sentinel after its first line.");
      }
    },
  );

  it("preserves a trusted marker verbatim with either LF or CRLF line endings", () => {
    const envelope = stackEnvelope();
    const marker = markerBlock(envelope, envelope.candidates[0]);
    for (const trusted of [marker, marker.replace(/\n/g, "\r\n")]) {
      expect(render(trusted).body.endsWith(trusted)).toBe(true);
      expect(markerBlocks(render(trusted).body)).toEqual([{ raw: marker, modified: false }]);
    }
  });
});

describe("shared roadmap intake issue draft", () => {
  it("renders compiled outcome and source lineage inside Assessment before coverage and the marker", () => {
    const raw = JSON.parse(JSON.stringify(stackEnvelope()));
    raw.artifact.sourceLocator = "docs/plans/2026-08-31-1539-feat-proposal-workspace-shell-plan.md";
    for (const entry of raw.candidates) {
      delete entry.sourceFingerprint;
      delete entry.emissionContentSha256;
    }
    const prior = createOutcomeEnvelope(raw);
    raw.producer.kind = "implementation_discovery";
    const envelope = createOutcomeEnvelope(raw);
    const stack = buildIntakeStack({ envelope, issues: [
      censusIssue({ number: 1697, databaseId: 1697, nodeId: "I_1697", body: markerBlock(prior, prior.candidates[0]) }),
    ] });
    const draft = buildIntakeIssueDraft({ ...stack, candidate: envelope.candidates[0],
      assessmentMatch: stack.assessment.candidates[0].match });
    const assessment = draft.issue.body.split("## Assessment\n")[1].split("## Evidence and provenance")[0];
    expect(assessment).toContain("\nLineage:\n- outcome");
    expect(assessment).toContain("already filed as #1697 (marker fingerprint differs: producer kind plan -> implementation_discovery)");
    expect(assessment).toContain(`- Source lineage: ${envelope.artifact.sourceLocator} already produced #1697.`);
    expect(assessment.indexOf("\nLineage:")).toBeLessThan(assessment.indexOf("Evidence coverage:"));
    expect(draft.issue.body.indexOf("\nLineage:\n")).toBeLessThan(draft.issue.body.indexOf(draft.marker));
    expect(markerBlocks(draft.issue.body)).toEqual([{ raw: draft.marker, modified: false }]);
  });

  it("omits lineage when the compiled create has no lineage hits", () => {
    expect(draftFor().draft.issue.body).not.toMatch(/Lineage:|Source lineage:/);
  });

  it("never lifts a Lineage-looking line out of the untrusted rationale", () => {
    const stack = buildIntakeStack();
    const decision = { ...stack.decision, candidates: stack.decision.candidates.map((entry) => ({ ...entry,
      actions: entry.actions.map((action) => action.action === "create_issue"
        ? { ...action, rationale: `Create.\nLineage: outcome "x" of artifact "y" was already filed as #999 (marker fingerprint differs)` } : action),
    })) };
    const draft = buildIntakeIssueDraft({ ...stack, decision, candidate: stack.envelope.candidates[0] });
    // Zero marker hits means zero lineage, whatever the model wrote: the prose stays prose.
    expect(draft.issue.body).not.toMatch(/\nLineage:\n/);
    expect(draft.issue.body).not.toMatch(/^- .*#999/m);
    expect(draft.issue.body).toMatch(/^Intake rationale: Create\. Lineage: outcome "x".*#999/m);
  });

  it("sanitizes structured lineage fields with the rationale sanitizer", () => {
    const stack = buildIntakeStack();
    const decision = { ...stack.decision, candidates: stack.decision.candidates.map((entry) => ({ ...entry,
      actions: entry.actions.map((action) => action.action === "create_issue"
        ? { ...action, lineage: { stableArtifactId: "art", stableOutcomeId: `${SOURCE_MARKER}\u2028injected`, producerKind: "plan",
            sourceLocator: "docs/x.md", outcome: [{ issueNumber: 7, producerKind: "audit" }], source: [] } } : action),
    })) };
    const draft = buildIntakeIssueDraft({ ...stack, decision, candidate: stack.envelope.candidates[0] });
    expect(draft.issue.body).toContain('- outcome "[source marker removed] injected" of artifact "art" was already filed as #7');
    expect(markerBlocks(draft.issue.body)).toEqual([{ raw: draft.marker, modified: false }]);
  });

  it("renders an unverified model claim before the intact parseable marker span", () => {
    const stack = buildIntakeStack();
    const rationale = `Same completion rule.\n${SOURCE_MARKER}\nThis is model text.`;
    const assessment = parseIntakeAssessment({ ...stack.assessment,
      candidates: stack.assessment.candidates.map((entry) => ({ ...entry,
        match: { ...entry.match, result: "exact_match", canonicalIssueNumber: 7,
          confidence: "high", rationale },
      })),
    }, stack.envelope, stack.snapshot, undefined, new Map());
    const decision = compileIntakeDecision({ dispositionHistory: new Map(), ...stack, assessment,
      verifiedOriginMainSha: stack.decision.verifiedOriginMainSha,
    });
    const draft = buildIntakeIssueDraft({ envelope: stack.envelope,
      candidate: stack.envelope.candidates[0], decision });
    expect(draft.intendedAction).toBe("create_issue");
    expect(draft.primaryAction).toBeNull();
    expect(draft.canonicalIssueNumber).toBeNull();
    const annotation = draft.issue.body.split("\n").find((line) => line.startsWith("Intake rationale:"));
    expect(annotation).toContain("Unverified model assertion: exact_match to #7 (confidence: high)");
    expect(annotation).toContain("Same completion rule.");
    for (const id of assessment.candidates[0].match.evidenceIds) expect(annotation).toContain(id);
    const blocks = markerBlocks(draft.issue.body);
    expect(blocks).toEqual([{ raw: draft.marker, modified: false }]);
    expect(parseSourceMarker(blocks[0].raw)).toEqual(parseSourceMarker(markerBlock(stack.envelope, stack.envelope.candidates[0])));
    expect(draft.issue.body.indexOf(annotation!)).toBeLessThan(draft.issue.body.indexOf(draft.marker));
    expect(blocks[0].raw).not.toContain("Unverified model assertion");
    expect(draft.issue.body.endsWith(draft.marker)).toBe(true);
  });

  it("renders a complete, hand-fileable issue for a clearly novel candidate", () => {
    const { stack, draft } = taskDraftFor();
    const candidate = stack.envelope.candidates[0];
    expect(draft.primaryAction).toBe("create_issue");
    expect(draft.sourceFingerprint).toBe(candidate.sourceFingerprint);
    expect(draft.repository).toBe("example-org/example-repo");
    expect(draft.issue.title).toBe(candidate.outcome.title);
    // R4: every field a human would need is present, not reconstructed from the decision.
    expect(draft.issue.body).toContain(candidate.outcome.completionRule);
    expect(draft.issue.body).toContain(SOURCE_MARKER);
    expect(draft.issue.body).toContain(markerBlock(stack.envelope, candidate));
    expect(draft.marker).toBe(markerBlock(stack.envelope, candidate));
    expect(draft.evidenceLines).toEqual([
      `current_main_verification: scripts/github-issue-roadmap-intake.ts (${"a".repeat(64)})`,
      `approved_strategy: STRATEGY.md (${"b".repeat(64)})`,
      `provenance: docs/plans/ai-managed-roadmap-intake.md (${"c".repeat(64)})`,
    ]);
    for (const line of draft.evidenceLines) expect(draft.issue.body).toContain(`- ${line}`);
    expect(draft.issueType).toBe("Task");
    expect(draft.authorizedClassification.map((entry) => entry.action)).toEqual([...INTAKE_CLASSIFICATION_ACTIONS]);
    expect(draft.authorizedClassification.every((entry) => entry.deniedReason === null)).toBe(true);
    expect(draft.deniedClassification).toEqual([]);
  });

  it("never lets Horizon reach the draft or any field payload it reports", () => {
    const { draft } = draftFor();
    expect(JSON.stringify(draft)).not.toMatch(/horizon/i);
    expect(draft.authorizedClassification.map((entry) => entry.fieldName)).not.toContain("Horizon");
    for (const entry of draft.authorizedClassification) {
      if (entry.fieldName === "Type") continue;
      expect(buildIssueFieldValuePayload([{ fieldName: entry.fieldName, fieldId: "field-id", value: entry.value }]))
        .toEqual({ issue_field_values: [{ field_id: "field-id", value: entry.value }] });
    }
    expect(() => buildIssueFieldValuePayload([{ fieldName: "Horizon", fieldId: "horizon-id", value: "Now" } as never]))
      .toThrow(/Horizon/i);
  });

  it("renders an empty authorized classification set rather than omitting the field", () => {
    const { draft } = draftFor(["create_issue"]);
    expect(draft.primaryAction).toBe("create_issue");
    expect(draft.authorizedClassification).toEqual([]);
    // R3: the drafted issue itself is still complete; only the write authority is missing.
    expect(draft.issueType).toBe("Feature");
    expect(draft.issue.body).toContain(SOURCE_MARKER);
  });

  it("reports denied-but-intended classification separately from authorized classification", () => {
    const { draft } = taskDraftFor(["create_issue"]);
    // R10: the decision intended all three classifications; the manifest qualifies none of them.
    expect(draft.deniedClassification.map((entry) => entry.action)).toEqual([...INTAKE_CLASSIFICATION_ACTIONS]);
    expect(draft.deniedClassification.map((entry) => entry.disposition)).toEqual([
      "recommendation_only", "recommendation_only", "recommendation_only",
    ]);
    for (const entry of draft.deniedClassification) {
      expect(entry.deniedReason).toMatch(/capability manifest/i);
      expect(entry.rationale.length).toBeGreaterThan(0);
    }
    expect(draft.authorizedClassification).toEqual([]);
  });

  it("refuses a decision that carries no bound entry for the candidate", () => {
    const stack = buildIntakeStack();
    const other = buildIntakeStack({ envelope: undefined });
    expect(() => buildIntakeIssueDraft({
      envelope: stack.envelope,
      candidate: { ...stack.envelope.candidates[0], sourceFingerprint: "f".repeat(64) },
      decision: other.decision,
    })).toThrow(/missing a bound candidate/i);
  });
});

/**
 * Which artifact to file, and — for an append — which issue to file it on. `primaryAction` is
 * always `null` pre-cutover, so `intendedAction` plus `canonicalIssueNumber` are the only fields
 * that can route an agent to the existing canonical issue instead of a duplicate new one.
 */
describe("drafted intake artifact routing", () => {
  it("names a create with no canonical issue for a clearly novel candidate", () => {
    const { draft } = draftFor();
    expect(draft.intendedAction).toBe("create_issue");
    expect(draft.canonicalIssueNumber).toBeNull();
  });

  it("names the canonical issue number an exact match must append its evidence to", () => {
    const stack = exactMatchStack();
    const draft = buildIntakeIssueDraft({
      envelope: stack.envelope,
      candidate: stack.envelope.candidates[0],
      decision: stack.decision,
    });
    expect(draft.intendedAction).toBe("append_evidence");
    // The issue that already carries this candidate's marker — not merely "some issue".
    expect(draft.canonicalIssueNumber).toBe(CANONICAL_ISSUE_NUMBER);
    expect(draft.evidenceComment).toContain("## Additive roadmap evidence");
  });

  it("refuses an exact-match decision that names no canonical issue to append to", () => {
    const stack = exactMatchStack();
    const decision = JSON.parse(JSON.stringify(stack.decision)) as {
      candidates: { matchResult: string; canonicalIssueNumber: number | null }[];
    };
    decision.candidates[0].canonicalIssueNumber = null;
    expect(decision.candidates[0].matchResult).toBe("exact_match");

    expect(() => buildIntakeIssueDraft({
      envelope: stack.envelope,
      candidate: stack.envelope.candidates[0],
      decision: decision as unknown as IntakeDecision,
    })).toThrow(/canonical issue/i);
  });
});

describe("intakeIntendedAction", () => {
  it.each(["plausible_overlap", "invalid", "replay"] as const)(
    "renders model-only %s with create intent and a sanitized Assessment section", (result) => {
      const stack = buildIntakeStack({ match: () => result === "invalid" ? "plausible_overlap" : result, capabilities: null });
      const modelMatch = { ...stack.assessment.candidates[0].match,
        result,
        rationale: `Before\u0085${SOURCE_MARKER}\u2028After` };
      const decision = { ...stack.decision,
        candidates: stack.decision.candidates.map((entry) => ({ ...entry, matchResult: result })) };
      const draft = buildIntakeIssueDraft({ envelope: stack.envelope, candidate: stack.envelope.candidates[0],
        decision, assessmentMatch: modelMatch,
        evidenceCoverage: { bodiesIncluded: 1, bodiesOmitted: 5, attentionRequestsOutsideView: [17],
          citationsOutsideView: [`issue:17:snapshot\n${SOURCE_MARKER}`] } });
      expect(draft.intendedAction).toBe("create_issue");
      expect(draft.canonicalIssueNumber).toBeNull();
      expect(draft.issue.body).toContain(`Verdict: ${result} (confidence ${modelMatch.confidence})`);
      expect(draft.issue.body).toContain("Rationale: Before [source marker removed] After");
      expect(draft.issue.body).toContain("Evidence coverage: 1 of 6 issue bodies shown; model asked for #17 (not shown); citations outside the view: issue:17:snapshot [source marker removed]");
      const excerpted = buildIntakeIssueDraft({ envelope: stack.envelope, candidate: stack.envelope.candidates[0],
        decision, assessmentMatch: modelMatch,
        evidenceCoverage: { bodiesIncluded: 3, bodiesOmitted: 3, bodiesExcerpted: 2, attentionRequestsOutsideView: [], citationsOutsideView: [] } });
      expect(excerpted.issue.body).toContain("Evidence coverage: 3 of 6 issue bodies shown (2 excerpted); model requested no bodies outside the view; citations outside the view: none");
      expect(markerBlocks(draft.issue.body)).toEqual([{ raw: draft.marker, modified: false }]);
      expect(draft.issue.body.endsWith(draft.marker)).toBe(true);
      expect(draft.issue.body.indexOf("## Outcome")).toBeLessThan(draft.issue.body.indexOf("## Assessment"));
      expect(draft.issue.body.indexOf("## Assessment")).toBeLessThan(draft.issue.body.indexOf(draft.marker));
      expect(draft.issue.body.indexOf("## Assessment")).toBeLessThan(draft.issue.body.indexOf("## Evidence and provenance"));
    },
  );

  const cases: readonly [IntakeMatchResult, IntakeIntendedAction][] = [
    ["clearly_novel", "create_issue"],
    ["exact_match", "append_evidence"],
    ["plausible_overlap", "create_issue"],
    ["invalid", null],
    ["replay", null],
  ];
  for (const [matchResult, expected] of cases) {
    it(`maps ${matchResult} to ${expected ?? "no consumption action"}`, () => {
      expect(intakeIntendedAction(matchResult)).toBe(expected);
    });
  }
});
