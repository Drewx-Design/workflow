import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import manifest from "../../github-issue-roadmap-capabilities.json";
import { assertCapabilityExecutable, type DispatcherCapabilityManifest } from "./capability-manifest";
import { canonicalJsonSha256 } from "./canonical-json";
import { assessmentStackSha256, parseAssessmentStackDescriptor } from "./intake-assessment";
import { JUDGEMENT_RECORD_DIRECTORY, MODEL_ACTION_KINDS, parseActionLabel, parseActionLabelPanelFamilies, parseJudgementRecord, readJudgementRecordRevisions, type ActionLabel, type JudgementRecord } from "./judgement-record";

// The only source of thresholds for granting and revoking model-action authority.
// A wrong close hides open work silently, so close needs a larger clean sample:
// zero wrong in 50 bounds the wrong-close rate near 6% (95% upper), versus 14% at 20.
export const ACTION_QUALIFICATION_BAR = Object.freeze({
  minimumPrecision: 0.95,
  minimumLabeledCases: Object.freeze({ append_evidence_overlap: 20, close_issue_existence: 50 }),
  maximumWrongCloses: 0,
});

/** Unknown kinds take the strictest minimum, so a new kind never inherits the looser one. */
function minimumLabeledCasesFor(kind: string): number {
  const minimums: Readonly<Record<string, number>> = ACTION_QUALIFICATION_BAR.minimumLabeledCases;
  return Object.prototype.hasOwnProperty.call(minimums, kind) ? minimums[kind] : Math.max(...Object.values(minimums));
}

export interface ActionQualificationContext {
  readonly manifest?: DispatcherCapabilityManifest | null;
  readonly runtimeEnabled?: boolean;
  readonly repoRoot?: string;
  readonly judgementRoot?: string;
  readonly assessmentStackSha256?: string;
  /** Exact verified origin/main blob bytes loaded by the outer CLI, which alone may invoke Git. */
  readonly committedLabelSets?: Readonly<Record<string, Buffer | null>>;
  /** Local committed evidence can only revoke merged authority. */
  readonly revocationLabelSets?: Readonly<Record<string, Buffer | null>>;
}

// Only synchronous compilation may inherit a context. No I/O callback or ambient
// credential enters the shadow closure, and the binding never spans an await.
let compilationContext: ActionQualificationContext = {};
export function withActionQualificationContext<T>(context: ActionQualificationContext, compile: () => T): T {
  const previous = compilationContext;
  compilationContext = context;
  try { return compile(); } finally { compilationContext = previous; }
}

export const ACTION_QUALIFICATION_COMMAND = "npm run roadmap:action-qualification";
export const ACTION_LABEL_SET_DIRECTORY = "scripts/roadmap-intake-qualification";
export const ACTION_LABEL_QUESTION_SCHEMA = "github-issue-roadmap-action-label-question/v2" as const;
export const PANEL_ELIGIBLE_ASSESSMENT_PROVIDERS = ["openai"] as const;

export function currentAssessmentStack(repoRoot: string) {
  const prompt = "scripts/github-issue-roadmap-assessment-prompt.md";
  return parseAssessmentStackDescriptor(
    JSON.parse(readFileSync(join(repoRoot, "scripts/github-issue-roadmap-automated-assessment-stack.json"), "utf8")),
    readFileSync(join(repoRoot, prompt), "utf8"), prompt);
}

export function currentAssessmentStackHash(repoRoot: string): string {
  return assessmentStackSha256(currentAssessmentStack(repoRoot));
}

/** The action label a record contributes to scoring under this stack, or undefined when the
 * record's actor, split or stack makes it ineligible. Plain `agent` labels never count. */
function eligibleActionLabel(record: JudgementRecord, stackHash: string): ActionLabel | undefined {
  if ((record.judgedBy !== "human_operator" && record.judgedBy !== "model_panel") || record.split !== "holdout"
    || record.observed.assessmentStackSha256 !== stackHash || record.extensions.actionLabel === undefined) return undefined;
  if (record.judgedBy === "model_panel" && record.extensions.evidenceVerified !== true) return undefined;
  return parseActionLabel(record.extensions.actionLabel);
}

/** The label a record contributes toward authority: eligible, and for a panel label, only while the
 * assessor's provider is allowlisted as a different family from both seats. The gate and both
 * labeling commands use this one rule, so no command can treat a case as settled that the gate
 * would not count. */
export function qualifyingActionLabel(record: JudgementRecord, stackHash: string, assessmentProvider: string): ActionLabel | undefined {
  if (record.judgedBy === "model_panel" && !(PANEL_ELIGIBLE_ASSESSMENT_PROVIDERS as readonly string[]).includes(assessmentProvider)) return undefined;
  return eligibleActionLabel(record, stackHash);
}

/** Pending questions plus set-aside ones, so a question whose stack becomes current again blocks again. */
export function actionLabelQuestionPaths(judgementRoot: string): string[] {
  return [join(judgementRoot, "questions"), join(judgementRoot, "questions", "stale")].flatMap(directory => existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith(".json")).map(entry => join(directory, entry.name))
    : []);
}

export interface ActionLabelQuestion {
  readonly schemaVersion: typeof ACTION_LABEL_QUESTION_SCHEMA;
  readonly assessmentStackSha256: string;
  readonly observationId: string;
  readonly actionKind: ActionLabel["actionKind"];
  readonly targetIssueNumber: number;
  readonly repository: string;
  readonly sourceFingerprint: string;
  readonly candidateTitle: string;
  readonly targetIssueTitle: string;
  readonly question: string;
  readonly createdAt: string;
  readonly seatVerdicts: readonly ({
    readonly family: "anthropic" | "glm";
    readonly verdict: "correct" | "incorrect" | "unsure";
  })[];
}

function questionObject(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} must be an object.`);
  return value as Record<string, unknown>;
}

function questionString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${context} must be a non-empty string.`);
  return value;
}

function questionSha256(value: unknown, context: string): string {
  const result = questionString(value, context);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${context} must be a lowercase SHA-256.`);
  return result;
}

export function parseActionLabelQuestion(value: unknown): ActionLabelQuestion {
  const raw = questionObject(value, "question");
  const expected = ["schemaVersion", "assessmentStackSha256", "observationId", "actionKind", "targetIssueNumber",
    "repository", "sourceFingerprint", "candidateTitle", "targetIssueTitle", "question", "createdAt", "seatVerdicts"].sort();
  if (JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify(expected)) {
    throw new Error(`question must contain exact keys [${expected.join(", ")}].`);
  }
  if (raw.schemaVersion !== ACTION_LABEL_QUESTION_SCHEMA) throw new Error("question.schemaVersion is unsupported.");
  const label = parseActionLabel({ repository: raw.repository, sourceFingerprint: raw.sourceFingerprint,
    actionKind: raw.actionKind, targetIssueNumber: raw.targetIssueNumber, verdict: "correct" });
  const createdAt = questionString(raw.createdAt, "question.createdAt");
  if (!Number.isFinite(Date.parse(createdAt))) throw new Error("question.createdAt must be an ISO timestamp.");
  if (!Array.isArray(raw.seatVerdicts) || raw.seatVerdicts.length !== 2) throw new Error("question.seatVerdicts must contain exactly two seats.");
  const seatVerdicts = raw.seatVerdicts.map((value, index): ActionLabelQuestion["seatVerdicts"][number] => {
    const seat = questionObject(value, `question.seatVerdicts[${index}]`);
    if (JSON.stringify(Object.keys(seat).sort()) !== JSON.stringify(["family", "verdict"])) {
      throw new Error(`question.seatVerdicts[${index}] must contain exact keys [family, verdict].`);
    }
    const family = seat.family;
    const verdict = seat.verdict;
    if (family !== "anthropic" && family !== "glm") throw new Error(`question.seatVerdicts[${index}].family is unsupported.`);
    if (verdict !== "correct" && verdict !== "incorrect" && verdict !== "unsure") {
      throw new Error(`question.seatVerdicts[${index}].verdict is unsupported.`);
    }
    return { family, verdict };
  });
  if (seatVerdicts[0].family === seatVerdicts[1].family) throw new Error("question.seatVerdicts must contain different families.");
  return { schemaVersion: ACTION_LABEL_QUESTION_SCHEMA,
    assessmentStackSha256: questionSha256(raw.assessmentStackSha256, "question.assessmentStackSha256"),
    observationId: questionSha256(raw.observationId, "question.observationId"), actionKind: label.actionKind,
    targetIssueNumber: label.targetIssueNumber, repository: label.repository, sourceFingerprint: label.sourceFingerprint,
    candidateTitle: questionString(raw.candidateTitle, "question.candidateTitle"),
    targetIssueTitle: questionString(raw.targetIssueTitle, "question.targetIssueTitle"),
    question: questionString(raw.question, "question.question"), createdAt, seatVerdicts };
}

/** One labeling case per repository, finding, kind and target, whichever filing run banked it. */
export function actionLabelCaseKey(label: Pick<ActionLabel, "repository" | "sourceFingerprint" | "actionKind" | "targetIssueNumber">): string {
  return [label.repository.toLowerCase(), label.sourceFingerprint, label.actionKind, label.targetIssueNumber].join(":");
}

export interface ActionLabelScore {
  readonly labeledCases: number;
  readonly correctCases: number;
  readonly precision: number | null;
  readonly wrongCloses: number;
  readonly qualified: boolean;
  readonly casesRemaining: number;
}

/** First eligible labeled attempt per case. Corrections to that attempt fail closed;
 * later attempts never inflate precision, but every wrong close remains a veto. */
export function summarizeActionLabels(records: readonly JudgementRecord[], kind: string, repository: string, stackHash: string): ActionLabelScore {
  const eligible = records.map(parseJudgementRecord).filter(record => {
    const label = eligibleActionLabel(record, stackHash);
    return label !== undefined && label.actionKind === kind && label.repository.toLowerCase() === repository.toLowerCase();
  }).sort((a, b) => Date.parse(a.observed.observedAt) - Date.parse(b.observed.observedAt)
    || Date.parse(a.judgedAt) - Date.parse(b.judgedAt) || a.observationId.localeCompare(b.observationId));
  const cases = new Map<string, { observationId: string; correct: boolean }>();
  const wrongCloses = new Set<string>();
  for (const record of eligible) {
    const label = parseActionLabel(record.extensions.actionLabel);
    const key = canonicalJsonSha256([label.repository.toLowerCase(), label.sourceFingerprint, kind, label.targetIssueNumber, stackHash]);
    const correct = label.verdict === "correct";
    const first = cases.get(key);
    if (first === undefined) cases.set(key, { observationId: record.observationId, correct });
    // A negative label on any filing run of the case fails it closed; later positives never restore it.
    else if (!correct) first.correct = false;
    if (kind === "close_issue_existence" && !correct) wrongCloses.add(`${record.observationId}:${label.targetIssueNumber}`);
  }
  const labeledCases = cases.size;
  const correctCases = [...cases.values()].filter(item => item.correct).length;
  const precision = labeledCases === 0 ? null : correctCases / labeledCases;
  const minimumLabeledCases = minimumLabeledCasesFor(kind);
  return { labeledCases, correctCases, precision, wrongCloses: wrongCloses.size,
    qualified: labeledCases >= minimumLabeledCases && precision !== null
      && precision >= ACTION_QUALIFICATION_BAR.minimumPrecision && wrongCloses.size <= ACTION_QUALIFICATION_BAR.maximumWrongCloses,
    casesRemaining: Math.max(0, minimumLabeledCases - labeledCases) };
}

function parseLabelSet(bytes: Buffer): JudgementRecord[] {
  const raw: unknown = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(raw)) throw new Error("Committed action label set must be an array of judgement records.");
  return raw.map(parseJudgementRecord);
}

export function readActionQualification(kind: string, context: ActionQualificationContext = compilationContext) {
  const repoRoot = context.repoRoot === undefined ? undefined : resolve(context.repoRoot);
  const modelAction = (MODEL_ACTION_KINDS as readonly string[]).includes(kind);
  const capabilities = context.manifest ?? (modelAction ? undefined : manifest as DispatcherCapabilityManifest);
  const empty = summarizeActionLabels([], kind, capabilities?.repository ?? "", "");
  let committed = empty;
  let allLabels = empty;
  let proofSha256: string | null = null;
  let stackHash: string | null = null;
  let blockingQuestions = 0;
  const result = (executable: boolean, reason: string) => ({ kind, executable, reason, assessmentStackSha256: stackHash,
    proofSha256, committed, allLabels, blockingQuestions, bar: ACTION_QUALIFICATION_BAR, fixingCommand: ACTION_QUALIFICATION_COMMAND });
  try {
    if (capabilities === undefined) return result(false, "qualification_context_missing");
    if (!modelAction) {
      assertCapabilityExecutable(capabilities, kind, "automatic", context.runtimeEnabled ?? true);
      return result(true, "production_capability");
    }
    if (repoRoot === undefined || context.judgementRoot === undefined || context.committedLabelSets === undefined) return result(false, "qualification_context_missing");
    const stack = currentAssessmentStack(repoRoot);
    stackHash = assessmentStackSha256(stack);
    if (context.assessmentStackSha256 !== undefined && context.assessmentStackSha256 !== stackHash) return result(false, "assessment_stack_changed_during_run");
    // Granting, progress, and every revocation prefix use the same current-family filter.
    // Panel provenance is re-validated here, so a malformed panel label fails closed.
    const scoreableRecords = (records: readonly JudgementRecord[]) => records.filter(record => {
      if (record.judgedBy !== "model_panel") return true;
      const label = parseActionLabel(record.extensions.actionLabel);
      parseActionLabelPanelFamilies(record.extensions.panel, label.verdict);
      return (PANEL_ELIGIBLE_ASSESSMENT_PROVIDERS as readonly string[]).includes(stack.provider);
    });
    const score = (records: readonly JudgementRecord[]) => summarizeActionLabels(scoreableRecords(records), kind, capabilities.repository, stackHash!);
    const locator = `${ACTION_LABEL_SET_DIRECTORY}/${kind}.json`;
    let committedRecords: JudgementRecord[] = [];
    const bytes = context.committedLabelSets[kind];
    if (bytes !== undefined && bytes !== null) {
      committedRecords = parseLabelSet(bytes);
      proofSha256 = createHash("sha256").update(bytes).digest("hex");
    }
    committed = score(committedRecords);
    const workingPath = join(repoRoot, locator);
    const localCommittedBytes = context.revocationLabelSets?.[kind];
    const liveRecords = [
      ...(localCommittedBytes == null ? [] : parseLabelSet(localCommittedBytes)),
      ...readJudgementRecordRevisions(join(context.judgementRoot, "labels")).map(item => item.record),
      ...readJudgementRecordRevisions(join(repoRoot, JUDGEMENT_RECORD_DIRECTORY)).map(item => item.record),
      ...(existsSync(workingPath) ? parseLabelSet(readFileSync(workingPath)) : []),
    ];
    allLabels = score([...committedRecords, ...liveRecords]);
    const capability = assertCapabilityExecutable(capabilities, kind, "automatic", context.runtimeEnabled ?? true);
    if (proofSha256 === null || capability.proofSha256 !== proofSha256) return result(false, "qualification_proof_mismatch");
    if (!committed.qualified) return result(false, "committed_labels_below_bar_or_stack_changed");
    // Uncommitted positive labels cannot restore authority after a negative label.
    // Replaying every uncommitted prefix retains revocation until a reviewed proof changes.
    const committedHashes = new Set(committedRecords.map(canonicalJsonSha256));
    const accumulated = [...committedRecords];
    for (const record of liveRecords.filter(record => !committedHashes.has(canonicalJsonSha256(record)))
      .sort((a, b) => Date.parse(a.judgedAt) - Date.parse(b.judgedAt) || a.observationId.localeCompare(b.observationId))) {
      accumulated.push(record);
      if (!score(accumulated).qualified) return result(false, "qualification_revoked_by_labels");
    }
    {
      let questions: ActionLabelQuestion[];
      try {
        questions = actionLabelQuestionPaths(context.judgementRoot)
          .map(path => parseActionLabelQuestion(JSON.parse(readFileSync(path, "utf8"))));
      } catch {
        return result(false, "label_questions_unreadable");
      }
      const eligibleKeys = new Set([...committedRecords, ...liveRecords].flatMap(record => {
        const label = qualifyingActionLabel(record, stackHash!, stack.provider);
        return label === undefined ? [] : [actionLabelCaseKey(label)];
      }));
      blockingQuestions = questions.filter(question => question.assessmentStackSha256 === stackHash
        && question.actionKind === kind && question.repository.toLowerCase() === capabilities.repository.toLowerCase()
        && !eligibleKeys.has(actionLabelCaseKey(question))).length;
      if (blockingQuestions > 0) return result(false, "unanswered_label_questions");
    }
    return result(true, "qualified");
  } catch (error) {
    return result(false, `qualification_unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The shared automatic-action boundary; unknown, disabled and unqualified kinds fail closed. */
export function isActionKindExecutable(kind: string, context: ActionQualificationContext = compilationContext): boolean {
  return readActionQualification(kind, context).executable;
}
