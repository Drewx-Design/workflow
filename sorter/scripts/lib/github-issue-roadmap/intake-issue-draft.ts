import type {
  AuthorityDisposition,
  IntakeActionDecision,
  IntakeDecision,
} from "./intake-decision";
import { CLAUSE_MEASUREMENT_BAR, CLAUSE_MEASUREMENT_BASELINE, SATISFIED_JUDGEMENT_MEASUREMENT } from "./intake-decision";
import type { CandidateIntakeAssessment, IntakeMatchResult } from "./intake-assessment";
import type { Confidence, OutcomeCandidate, OutcomeEnvelope } from "./outcome-candidate";
import { EFFORT_SUGGESTIONS, ISSUE_TYPE_SUGGESTIONS, PRIORITY_SUGGESTIONS } from "./outcome-candidate";
import { renderSourceMarker, SOURCE_MARKER, SOURCE_MARKER_LINE_COUNT } from "./source-marker";
import { lineageLines, type IntakeLineage } from "./intake-lineage";
import { AUTHORED_START_COMMANDS, type AuthoredStartCommand } from "./start-command-values";

/**
 * The one renderer for the issue a routine-intake decision would file.
 *
 * This module is deliberately pure and dependency-poor: it imports no consumption ledger, host
 * lock, credential, deployment, or transport module. Shadow mode renders the identical draft
 * without ever touching a write capability, and the executing create path calls the same builder,
 * so a drafted issue and a filed issue cannot diverge. Imports flow CLI -> lib only; nothing here
 * may reach back into `scripts/github-issue-roadmap-intake.ts`.
 */

export interface CreateIssuePayload { readonly title: string; readonly body: string }

// Bound individual model strings and aggregate prose well below GitHub's 65,536-character limit.
const ISSUE_TEXT_CHARACTER_LIMIT = 4_096;
const ISSUE_PROSE_CHARACTER_LIMIT = 24_576;
const TRUNCATION_MARKER = "… [truncated]";

function truncateText(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

function sanitizeIssueText(text: string): string {
  // Collapse BEFORE neutralization: JavaScript's \s misses U+0085 (NEL), so collapsing later
  // could manufacture an exact sentinel from a NEL-wrapped sentinel the regex did not remove.
  const collapsed = text.replace(/[\n\r\v\f\u0085\u2028\u2029]+/g, " ");
  // Covers both markerBlocks sentinel forms; remove the sentinel rather than relying on line layout.
  const neutralized = collapsed.replace(/<!--\s*github-issue-roadmap-source(?::v\d+)?\s*-->/gi, "[source marker removed]");
  return truncateText(neutralized, ISSUE_TEXT_CHARACTER_LIMIT);
}

function bodyWithMarker(sections: readonly string[], marker: string): string {
  const lines = marker.replace(/\r\n/g, "\n").split("\n");
  // Prefer non-filing (no marker) to a forged marker that silently suppresses future filing.
  // These sink checks must still hold if an upstream marker-field validator is weakened.
  if (lines.length !== SOURCE_MARKER_LINE_COUNT) {
    throw new Error(`Source marker must contain exactly ${SOURCE_MARKER_LINE_COUNT} lines before appending.`);
  }
  if (lines.slice(1).some((line) => line === SOURCE_MARKER ||
      /^\s*<!--\s*github-issue-roadmap-source(?::v\d+)?\s*-->\s*$/i.test(line))) {
    throw new Error("Source marker must not contain another sentinel after its first line.");
  }
  // Preserve the entire trusted marker even when many bounded embeds exhaust the prose budget.
  const prose = truncateText(sections.join("\n"), ISSUE_PROSE_CHARACTER_LIMIT);
  return `${prose}\n\n${marker}`;
}

/** The evidence and provenance lines every rendering of a candidate shares. */
function intakeEvidenceLines(candidate: OutcomeCandidate): string[] {
  return [
    ...candidate.evidence.map((entry) => `${entry.kind}: ${entry.sourceLocator} (${entry.contentSha256})`),
    ...candidate.provenance.map((entry) => `provenance: ${entry.sourceLocator} (${entry.contentSha256})`),
  ];
}

export type IntakeEvidenceCoverage = { readonly bound: false } | {
  readonly bodiesIncluded: number;
  readonly bodiesOmitted: number;
  /** Shown bodies that were excerpted to fit the view; absent on records written before excerpting. */
  readonly bodiesExcerpted?: number;
  readonly attentionRequestsOutsideView: readonly number[];
  readonly citationsOutsideView: readonly string[];
};

function coverageLine(coverage: IntakeEvidenceCoverage | null | undefined): string {
  if (coverage == null) return "Evidence coverage: unknown (no evidence-view record)";
  if ("bound" in coverage) return "Evidence coverage: unknown (evidence-view record not bound to this assessment)";
  return `Evidence coverage: ${coverage.bodiesIncluded} of ${coverage.bodiesIncluded + coverage.bodiesOmitted} issue bodies shown` +
    `${coverage.bodiesExcerpted ? ` (${coverage.bodiesExcerpted} excerpted)` : ""}; ` +
    (coverage.attentionRequestsOutsideView.length === 0 ? "model requested no bodies outside the view; " :
      `model asked for ${coverage.attentionRequestsOutsideView.map((number) => `#${number}`).join(", ")} (not shown); `) +
    `citations outside the view: ${coverage.citationsOutsideView.map(sanitizeIssueText).join(", ") || "none"}`;
}

function buildIssuePayload(input: {
  readonly title: string;
  readonly completionRule: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly startCommand?: AuthoredStartCommand;
  readonly marker: string;
  readonly evidenceLines: readonly string[];
  readonly intermediateSections?: readonly string[];
  readonly intakeRationale?: string;
  readonly lineage?: IntakeLineage;
  readonly assessment?: CandidateIntakeAssessment["match"];
  readonly classification?: readonly IntakeClassificationDraft[];
  readonly evidenceCoverage?: IntakeEvidenceCoverage | null;
}): CreateIssuePayload {
  const startCommand = input.startCommand;
  if (startCommand !== undefined && !AUTHORED_START_COMMANDS.includes(startCommand)) {
    throw new Error(`Invalid Start command value ${JSON.stringify(startCommand)}. Expected one of: ${AUTHORED_START_COMMANDS.join(", ")}.`);
  }
  const evidence = ["## Evidence and provenance", ...input.evidenceLines.map((line) => `- ${sanitizeIssueText(line)}`)];
  const assessment = input.assessment;
  const classification = input.classification ?? [];
  // Rendered from the structured record only. The rationale is untrusted model prose; a line in
  // it that happens to start with "Lineage:" is not lineage and must never be lifted into one.
  const lineage = input.lineage === undefined ? [] : lineageLines(input.lineage);
  const assessmentSections = assessment === undefined ? [] : [
    "## Assessment",
    `Verdict: ${assessment.result} (confidence ${assessment.confidence})`,
    `Intended classification: Type ${classification.find(({ action }) => action === "set_type")?.value ?? "none"}` +
      ` \u00b7 Priority ${classification.find(({ action }) => action === "set_priority")?.value ?? "none"}` +
      ` \u00b7 Effort ${classification.find(({ action }) => action === "set_effort")?.value ?? "none"}` +
      (startCommand === undefined ? "" : ` \u00b7 Start ${startCommand}`),
    ...(assessment.competingIssueNumbers.length === 0 ? [] : [
      `Possible overlap: ${assessment.competingIssueNumbers.map((number) => `#${number}`).join(", ")}`,
    ]),
    `Rationale: ${sanitizeIssueText(assessment.rationale)}`,
    ...(lineage.length === 0 ? [] : ["Lineage:", ...lineage.map((line) => `- ${sanitizeIssueText(line)}`)]),
    sanitizeIssueText(coverageLine(input.evidenceCoverage)),
    "",
  ];
  const criteria = input.acceptanceCriteria ?? [];
  const completionRule = sanitizeIssueText(input.completionRule);
  // Keep Outcome prose from becoming a heading or fence, with or without authored criteria.
  const outcomeLine = completionRule.replace(/^\s*([#`~])/, "\\$1");
  // U1 validated and bounded each authored item; keep its text separate from prose sanitization.
  const criteriaSections = criteria.length === 0 ? [] : [
    "## Acceptance criteria",
    ...criteria.map((item) => `- ${item}`),
    "",
    ...((input.intermediateSections?.length ?? 0) > 0 || input.intakeRationale !== undefined ? ["## Intake notes"] : []),
  ];
  return {
    title: sanitizeIssueText(input.title),
    body: bodyWithMarker([
      "## Outcome",
      outcomeLine,
      "",
      ...criteriaSections,
      ...(input.intermediateSections ?? []).map(sanitizeIssueText),
      // The fixed prefix is outside the embed cap, but inside the aggregate prose cap.
      // Keep it separate so moving sanitization here preserves existing rendered bodies.
      ...(input.intakeRationale === undefined ? [] : [`Intake rationale: ${sanitizeIssueText(input.intakeRationale)}`, ""]),
      ...assessmentSections,
      ...evidence,
    ], input.marker),
  };
}

export function buildCreateIssuePayload(input: {
  readonly title: string;
  readonly completionRule: string;
  readonly marker: string;
  readonly evidenceLines: readonly string[];
}): CreateIssuePayload {
  return buildIssuePayload(input);
}

export function buildEvidenceCommentBody(envelope: OutcomeEnvelope, candidate: OutcomeCandidate): string {
  return bodyWithMarker([
    "## Additive roadmap evidence",
    ...intakeEvidenceLines(candidate).map((line) => `- ${sanitizeIssueText(line)}`),
  ], renderSourceMarker(envelope, candidate));
}

export interface IssueFieldValueInput {
  readonly fieldName: "Priority" | "Effort";
  readonly fieldId: string;
  readonly value: string;
}

export interface IssueFieldValuePayload {
  readonly issue_field_values: readonly { readonly field_id: string; readonly value: string }[];
}

export function buildIssueFieldValuePayload(values: readonly IssueFieldValueInput[]): IssueFieldValuePayload {
  if (values.length === 0) throw new Error("Issue-field payload must be non-empty.");
  const issue_field_values = values.map((entry) => {
    if (entry.fieldName === ("Horizon" as string)) throw new Error("Routine intake structurally forbids Horizon field payloads.");
    if (entry.fieldId.trim() === "" || entry.value.trim() === "") throw new Error("Issue-field payload entries must be non-empty.");
    return { field_id: entry.fieldId, value: entry.value };
  });
  return { issue_field_values };
}

/**
 * Horizon is not a classification routine intake may draft, propose, or report. The closed set
 * below is the structural reason a Horizon value can never reach a drafted issue.
 */
export const INTAKE_CLASSIFICATION_ACTIONS = ["set_type", "set_priority", "set_effort"] as const;
export type IntakeClassificationActionKind = typeof INTAKE_CLASSIFICATION_ACTIONS[number];

const CLASSIFICATION_FIELD_NAMES: Readonly<Record<IntakeClassificationActionKind, "Type" | "Priority" | "Effort">> = {
  set_type: "Type", set_priority: "Priority", set_effort: "Effort",
};

const DENIAL_REASONS: Readonly<Record<Exclude<AuthorityDisposition, "automatic_safe">, string>> = {
  recommendation_only: "The capability manifest does not qualify this classification for automatic execution.",
  approval_required: "This classification requires exact human approval before any write.",
  hold_no_write: "The decision holds this candidate at zero writes.",
};

/**
 * One denial vocabulary. Shadow mode reports intended-but-denied actions (R10) with the same
 * wording a drafted classification carries, so an operator reads one reason per disposition.
 */
export function intakeDenialReason(disposition: Exclude<AuthorityDisposition, "automatic_safe">): string {
  return DENIAL_REASONS[disposition];
}

export interface IntakeClassificationDraft {
  readonly action: IntakeClassificationActionKind;
  readonly fieldName: "Type" | "Priority" | "Effort";
  readonly value: string;
  readonly disposition: AuthorityDisposition;
  readonly rationale: string;
  readonly confidence: Confidence;
  /** `null` exactly when the action is authorized; otherwise why routine intake could not take it. */
  readonly deniedReason: string | null;
}

/** What a drafted candidate is for, independent of whether intake may take it. */
export type IntakeIntendedAction = "create_issue" | "append_evidence" | "append_evidence_overlap" | "close_issue" | "close_issue_existence" | null;
type IntakePrimaryIntendedAction = Exclude<IntakeIntendedAction, "close_issue" | "close_issue_existence" | null>;

/** Compiled holds and creates disambiguate model-only verdicts from marker-backed outcomes. */
export function intakeIntendedAction(matchResult: IntakeMatchResult, actions?: readonly IntakeActionDecision[]): IntakePrimaryIntendedAction | null {
  if (actions?.some(({ action }) => action === "hold_invalid")) return null;
  if (actions?.some(({ action }) => action === "create_issue")) return "create_issue";
  if (actions?.some(({ action }) => action === "append_evidence_overlap")) return "append_evidence_overlap";
  if (matchResult === "clearly_novel" || matchResult === "plausible_overlap") return "create_issue";
  if (matchResult === "exact_match") return "append_evidence";
  return null;
}

export interface IntakeIssueDraft {
  readonly sourceFingerprint: string;
  readonly repository: string;
  /**
   * Which artifact this draft is: file `issue` as a new issue, or post `evidenceComment` on the
   * canonical issue. Derived from the match and compiled actions, so it is populated whether or not any
   * write is authorized — pre-cutover `primaryAction` is always `null`, and an agent reading only
   * that field cannot tell an `exact_match` append from a `clearly_novel` create and files a
   * duplicate issue. `null` only for a match result that drafts nothing.
   */
  readonly intendedAction: IntakePrimaryIntendedAction | null;
  /** Ordered operator-visible writes; close is valid only after append_evidence. */
  readonly intendedActions: readonly Exclude<IntakeIntendedAction, null>[];
  /**
   * The existing canonical issue an `append_evidence` draft must post `evidenceComment` on.
   * Non-null exactly when `intendedAction` is `append_evidence`; `null` otherwise. Without it an
   * agent told to append has no way to name the target issue and files a duplicate instead.
   */
  readonly canonicalIssueNumber: number | null;
  /** Human disclosure only; not part of the bound close payload. */
  readonly closeBasis: string | null;
  readonly closeIssue: {
    readonly targetIssueNumber: number;
    readonly before: "OPEN";
    readonly after: "CLOSED";
    readonly evidenceIds: readonly string[];
  } | null;
  /** The consumption action the decision *authorizes*, or `null` when it authorizes none. */
  readonly primaryAction: IntakePrimaryIntendedAction | null;
  /** The complete issue: file it by hand with no field reconstructed. */
  readonly issue: CreateIssuePayload;
  readonly marker: string;
  readonly evidenceLines: readonly string[];
  /** The body an `append_evidence` consumption would post against the canonical issue. */
  readonly evidenceComment: string;
  /** The native issue Type the decision names, whether or not intake may set it itself. */
  readonly issueType: string | null;
  readonly authorizedClassification: readonly IntakeClassificationDraft[];
  /** R10: classifications the decision intended but the capability manifest denies. */
  readonly deniedClassification: readonly IntakeClassificationDraft[];
}

function classificationDrafts(actions: readonly IntakeActionDecision[]): IntakeClassificationDraft[] {
  const kinds = new Set<string>(INTAKE_CLASSIFICATION_ACTIONS);
  const seen = new Set<IntakeClassificationActionKind>();
  return actions.filter((action) => kinds.has(action.action)).map((action) => {
    const kind = action.action as IntakeClassificationActionKind;
    if (seen.has(kind)) throw new Error(`Intake decision has more than one ${kind} classification action.`);
    seen.add(kind);
    const fieldName = CLASSIFICATION_FIELD_NAMES[kind];
    // Defense in depth: no Horizon-shaped classification may pass through a drafted issue.
    if ((fieldName as string) === "Horizon") throw new Error("Routine intake structurally forbids drafting a Horizon classification.");
    const value = String(action.proposed);
    const allowedValues: readonly string[] = {
      set_type: ISSUE_TYPE_SUGGESTIONS,
      set_priority: PRIORITY_SUGGESTIONS,
      set_effort: EFFORT_SUGGESTIONS,
    }[kind];
    if (!allowedValues.includes(value)) {
      throw new Error(`Invalid ${fieldName} classification value ${JSON.stringify(value)}. Expected one of: ${allowedValues.join(", ")}.`);
    }
    return {
      action: kind, fieldName, value, disposition: action.disposition,
      rationale: action.rationale, confidence: action.confidence,
      deniedReason: action.disposition === "automatic_safe" ? null : DENIAL_REASONS[action.disposition],
    };
  });
}

/**
 * Render the complete issue a decision would file for one candidate, plus its classification
 * actions split into what routine intake may take and what it may only report.
 */
export function buildIntakeIssueDraft(input: {
  readonly envelope: OutcomeEnvelope;
  readonly candidate: OutcomeCandidate;
  readonly decision: IntakeDecision;
  readonly assessmentMatch?: CandidateIntakeAssessment["match"];
  readonly evidenceCoverage?: IntakeEvidenceCoverage | null;
}): IntakeIssueDraft {
  const entry = input.decision.candidates.find((item) => item.sourceFingerprint === input.candidate.sourceFingerprint);
  if (entry === undefined) throw new Error("Intake decision is missing a bound candidate.");
  const actions = entry.actions;
  const primaryActions = actions.filter((action) =>
    action.disposition === "automatic_safe" && (action.action === "create_issue" || action.action === "append_evidence" || action.action === "append_evidence_overlap"));
  if (primaryActions.length > 1) throw new Error("A candidate may have only one automatic consumption action.");
  const intendedAction = intakeIntendedAction(entry.matchResult, actions);
  // Fail closed: an `exact_match` names an existing canonical issue by construction, so one that
  // arrives without a number is a contradiction inside the decision, not a draft to emit with a
  // hole in it. Emitting it would hand an agent an append instruction with no target.
  const isAppend = intendedAction === "append_evidence" || intendedAction === "append_evidence_overlap";
  if (isAppend && entry.canonicalIssueNumber === null) {
    throw new Error(
      `Intake decision for ${input.candidate.sourceFingerprint} matched an existing outcome but names ` +
      "no canonical issue to append its evidence to.",
    );
  }
  // Held to the same rule from the other side: only an append carries a target, so no other
  // presentation can leak an issue number an agent might act on.
  const canonicalIssueNumber = isAppend ? entry.canonicalIssueNumber : null;
  if (intendedAction === "append_evidence_overlap" && actions.find(action => action.action === intendedAction)?.targetIssueNumber !== canonicalIssueNumber) {
    throw new Error("A model append must target its bound canonical issue.");
  }
  const closeActions = actions.filter((action) => action.action === "close_issue" || action.action === "close_issue_existence");
  if (closeActions.length > 1) throw new Error("A candidate may have only one close action.");
  const closeAction = closeActions[0];
  if (closeAction !== undefined) {
    const appendIndex = actions.findIndex((action) => action.action === "append_evidence");
    const closeIndex = actions.indexOf(closeAction);
    if (intendedAction !== "append_evidence" || appendIndex < 0 || closeIndex !== appendIndex + 1 ||
        canonicalIssueNumber === null || closeAction.targetIssueNumber !== canonicalIssueNumber ||
        closeAction.before !== "OPEN" || closeAction.proposed !== "CLOSED") {
      throw new Error("A close action must immediately follow evidence append for the same open canonical issue.");
    }
  }
  const marker = renderSourceMarker(input.envelope, input.candidate);
  const evidenceLines = intakeEvidenceLines(input.candidate);
  const classification = classificationDrafts(actions);
  const type = classification.find((draft) => draft.action === "set_type");
  const createAction = actions.find((action) => action.action === "create_issue");
  return {
    sourceFingerprint: input.candidate.sourceFingerprint,
    repository: `${input.envelope.repository.organization}/${input.envelope.repository.name}`,
    intendedAction,
    intendedActions: intendedAction === null
      ? []
      : closeAction === undefined ? [intendedAction] : [intendedAction, closeAction.action as "close_issue" | "close_issue_existence"],
    canonicalIssueNumber,
    closeBasis: closeAction === undefined ? null :
      "This close rests on the probe scoring every completion clause satisfied with a citation. " +
      "The citation matcher accepts an export declaration as the witness; it is not proof the requirement's behaviour exists. " +
      `The only measured figure is unsatisfied-clause recovery over ${CLAUSE_MEASUREMENT_BASELINE.partialCandidates} partial candidates ` +
      `(${CLAUSE_MEASUREMENT_BASELINE.expectedClauses} expected, ${CLAUSE_MEASUREMENT_BASELINE.emittedClauses} emitted clauses): ` +
      `recall ${(CLAUSE_MEASUREMENT_BASELINE.recall * 100).toFixed(1)}%, ` +
      `precision ${(CLAUSE_MEASUREMENT_BASELINE.precision * 100).toFixed(1)}%, against a ${CLAUSE_MEASUREMENT_BAR.toFixed(2)} bar. ` +
      "These figures were measured on a labeled cohort, not on this candidate. " +
      (() => {
        const { cohort, census } = SATISFIED_JUDGEMENT_MEASUREMENT;
        const populations = [
          { measurement: cohort, name: "labeled cohort" },
          { measurement: census, name: "production" },
        ];
        const unestimated = populations.filter(({ measurement }) =>
          measurement.precision === null && measurement.satisfiedClauses === 0);
        const disclosures: string[] = [];
        if (unestimated.length > 0) {
          disclosures.push(
            "The precision of the satisfied judgement, the one this close rests on, is not estimable, " +
            "because the probe scored no clause satisfied across " +
            unestimated.map(({ measurement, name }) =>
              `${measurement.candidates} ${name} candidates (${measurement.clauses} clauses) at ${measurement.commit.slice(0, 8)}`,
            ).join(" and ") + ".",
          );
        }
        for (const { measurement, name } of populations) {
          const precision = measurement.precision;
          if (precision === null && measurement.satisfiedClauses > 0) {
            disclosures.push(
              `The probe scored ${measurement.satisfiedClauses} clauses satisfied across ${measurement.candidates} ${name} candidates ` +
              `(${measurement.clauses} clauses) at ${measurement.commit.slice(0, 8)}; they are not yet labeled, so that precision is not yet estimated.`,
            );
          }
          if (precision !== null) {
            disclosures.push(
              `The precision of the satisfied judgement, the one this close rests on, is ${precision.truePositives}/${precision.emitted} ` +
              `(95% Clopper-Pearson interval [${precision.interval95.lower}, ${precision.interval95.upper}], labeler: ${precision.labeler}) ` +
              `across ${measurement.candidates} ${name} candidates (${measurement.clauses} clauses) at ${measurement.commit.slice(0, 8)}.`,
            );
          }
        }
        if (cohort.demonstratedVerdicts === 0 && census.demonstratedVerdicts === 0) {
          disclosures.push("A proposed close lies outside every population measured so far.");
        }
        return disclosures.join(" ");
      })(),
    closeIssue: closeAction === undefined ? null : {
      targetIssueNumber: closeAction.targetIssueNumber!,
      before: "OPEN",
      after: "CLOSED",
      evidenceIds: closeAction.evidenceIds,
    },
    primaryAction: (primaryActions[0]?.action as IntakePrimaryIntendedAction | undefined) ?? null,
    issue: buildIssuePayload({
      title: input.candidate.outcome.title,
      completionRule: input.candidate.outcome.completionRule,
      acceptanceCriteria: input.candidate.acceptanceCriteria,
      startCommand: input.candidate.startCommand,
      marker, evidenceLines,
      intermediateSections: entry.existenceOutcome?.kind === "partial_released_unqualified" ? [
        "Filed on a partial existence verdict. The probe scored these clauses as already satisfied on origin/main:",
        ...entry.existenceOutcome.satisfiedClauses.map((clause) => `- ${clause}`),
        "",
      ] : undefined,
      intakeRationale: createAction?.rationale,
      lineage: createAction?.lineage,
      assessment: input.assessmentMatch ?? {
        result: entry.matchResult, confidence: createAction?.confidence ?? actions[0]?.confidence ?? "low",
        canonicalIssueNumber: entry.canonicalIssueNumber, competingIssueNumbers: entry.competingIssueNumbers,
        rationale: createAction?.rationale ?? actions[0]?.rationale ?? "No model rationale recorded.",
        evidenceIds: createAction?.evidenceIds ?? [],
      },
      evidenceCoverage: input.evidenceCoverage,
      classification,
    }),
    marker, evidenceLines,
    evidenceComment: buildEvidenceCommentBody(input.envelope, input.candidate),
    issueType: type?.value ?? null,
    authorizedClassification: classification.filter((draft) => draft.deniedReason === null),
    deniedClassification: classification.filter((draft) => draft.deniedReason !== null),
  };
}
