import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CreateIssuePayload } from "./lib/github-issue-roadmap/intake-issue-draft";
import type { IntakeDispositionSkip } from "./lib/github-issue-roadmap/intake-assessment";

export const INTAKE_APPROVAL_PLAN_SCHEMA = "github-issue-roadmap-intake-approval-plan/v1" as const;

type JsonObject = Record<string, unknown>;

export interface ApprovalClassification {
  readonly action: string;
  readonly fieldName: string;
  value: string | null;
  readonly confidence: string;
  readonly rationale: string;
}

export interface IntakeApprovalHold {
  readonly reason: string;
  readonly rationale: string;
  readonly issue: CreateIssuePayload | null;
  readonly competingIssueNumbers: readonly number[];
  readonly competingIssues: readonly {
    readonly number: number;
    readonly title: string;
    readonly state: "OPEN" | "CLOSED";
    readonly updatedAt: string;
  }[];
  readonly evidenceIds: readonly string[];
}

export interface IntakeApprovalReplay {
  readonly targetIssueNumber: number | null;
  readonly rationale: string;
  readonly evidenceIds: readonly string[];
  readonly confidence: string;
}

export interface IntakeApprovalDecisionBinding {
  readonly path: string;
  readonly contentSha256: string;
  readonly existenceRecordContentSha256?: string;
  readonly verifiedOriginMainSha?: string;
}

export interface IntakeApprovalEntry {
  readonly decisionReport: IntakeApprovalDecisionBinding;
  readonly sourceFingerprint: string;
  readonly presentation: "draft" | "hold" | "replay_no_op";
  readonly approvable: boolean;
  approved: boolean;
  readonly intendedAction: "create_issue" | "append_evidence" | "append_evidence_overlap" | null;
  readonly intendedActions: readonly ("create_issue" | "append_evidence" | "append_evidence_overlap" | "close_issue" | "close_issue_existence")[];
  readonly canonicalIssueNumber: number | null;
  /** Human disclosure only; not part of the bound close payload. */
  readonly closeBasis: string | null;
  readonly closeIssue: {
    readonly targetIssueNumber: number;
    readonly before: "OPEN";
    readonly after: "CLOSED";
    readonly evidenceIds: readonly string[];
  } | null;
  readonly issue: { readonly title: string; readonly body: string } | null;
  readonly evidenceComment: string | null;
  readonly deniedClassification: ApprovalClassification[];
  readonly hold: IntakeApprovalHold | null;
  readonly replay: IntakeApprovalReplay | null;
}

export interface IntakeApprovalPlan {
  readonly schemaVersion: typeof INTAKE_APPROVAL_PLAN_SCHEMA;
  readonly generatedAt: string;
  readonly decision: IntakeApprovalDecisionBinding;
  readonly decisions: readonly IntakeApprovalDecisionBinding[];
  readonly entries: IntakeApprovalEntry[];
  readonly skipped?: readonly IntakeApprovalSkipped[];
}

export interface IntakeApprovalSkipped extends IntakeDispositionSkip {
  readonly decisionReport: IntakeApprovalDecisionBinding;
  readonly approvable: false;
  readonly approved: false;
}

function object(value: unknown, context: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
  return value as JsonObject;
}

function text(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${context} must be non-empty text.`);
  return value;
}

function nullableText(value: unknown, context: string): string | null {
  return value === null ? null : text(value, context);
}

function classificationFromDraft(raw: unknown, context: string): ApprovalClassification {
  const value = object(raw, context);
  return {
    action: text(value.action, `${context}.action`),
    fieldName: text(value.fieldName, `${context}.fieldName`),
    value: nullableText(value.value, `${context}.value`),
    confidence: text(value.confidence, `${context}.confidence`),
    rationale: text(value.rationale, `${context}.rationale`),
  };
}

function textArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array.`);
  return value.map((entry, index) => text(entry, `${context}[${index}]`));
}

function positiveInteger(value: unknown, context: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${context} must be a positive integer.`);
  return value as number;
}

function sha256(value: unknown, context: string): string {
  const result = text(value, context);
  if (!/^[0-9a-f]{64}$/.test(result)) throw new Error(`${context} must be a lowercase SHA-256.`);
  return result;
}

function gitSha(value: unknown, context: string): string {
  const result = text(value, context);
  if (!/^[0-9a-f]{40}$/.test(result)) throw new Error(`${context} must be a lowercase Git SHA.`);
  return result;
}

function holdFromCandidate(candidate: JsonObject, context: string): IntakeApprovalHold {
  const hold = object(candidate.hold, `${context}.hold`);
  if (!Array.isArray(hold.competingIssueNumbers)) throw new Error(`${context}.hold.competingIssueNumbers must be an array.`);
  if (!Array.isArray(hold.competingIssues)) throw new Error(`${context}.hold.competingIssues must be an array.`);
  return {
    reason: text(hold.reason, `${context}.hold.reason`),
    rationale: text(hold.rationale, `${context}.hold.rationale`),
    // An absent key and an explicit null both mean "no fileable payload". A decision report
    // written before hold payloads existed omits the key entirely, and every already-collected
    // drain on disk is such a report -- requiring the key would make those unreadable rather
    // than merely unadorned. A present-but-wrong value still fails closed below.
    issue: hold.issue === null || hold.issue === undefined
      ? null
      : (() => {
        const issue = object(hold.issue, `${context}.hold.issue`);
        return {
          title: text(issue.title, `${context}.hold.issue.title`),
          body: text(issue.body, `${context}.hold.issue.body`),
        };
      })(),
    competingIssueNumbers: hold.competingIssueNumbers.map((entry, index) =>
      positiveInteger(entry, `${context}.hold.competingIssueNumbers[${index}]`)),
    competingIssues: hold.competingIssues.map((rawIssue, index) => {
      const issue = object(rawIssue, `${context}.hold.competingIssues[${index}]`);
      const state = text(issue.state, `${context}.hold.competingIssues[${index}].state`);
      if (state !== "OPEN" && state !== "CLOSED") throw new Error(`${context}.hold.competingIssues[${index}].state is unsupported.`);
      return {
        number: positiveInteger(issue.number, `${context}.hold.competingIssues[${index}].number`),
        title: text(issue.title, `${context}.hold.competingIssues[${index}].title`),
        state,
        updatedAt: text(issue.updatedAt, `${context}.hold.competingIssues[${index}].updatedAt`),
      };
    }),
    evidenceIds: textArray(hold.evidenceIds, `${context}.hold.evidenceIds`),
  };
}

function replayFromReport(report: JsonObject, fingerprint: string): IntakeApprovalReplay | null {
  const decision = object(report.decision, "decision report decision");
  if (!Array.isArray(decision.candidates)) throw new Error("decision report decision.candidates must be an array.");
  const candidate = decision.candidates.map((entry, index) => object(entry, `decision.candidates[${index}]`))
    .find((entry) => entry.sourceFingerprint === fingerprint);
  if (candidate === undefined || !Array.isArray(candidate.actions)) return null;
  const action = candidate.actions.map((entry, index) => object(entry, `decision action[${index}]`))
    .find((entry) => entry.action === "replay_no_op");
  if (action === undefined) return null;
  return {
    targetIssueNumber: action.targetIssueNumber === null
      ? null
      : positiveInteger(action.targetIssueNumber, "replay_no_op.targetIssueNumber"),
    rationale: text(action.rationale, "replay_no_op.rationale"),
    evidenceIds: textArray(action.evidenceIds, "replay_no_op.evidenceIds"),
    confidence: text(action.confidence, "replay_no_op.confidence"),
  };
}

export function sha256Content(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function buildIntakeApprovalPlan(input: {
  readonly decisionPath: string;
  readonly decisionContent: string;
  readonly now?: Date;
}): IntakeApprovalPlan {
  const report = object(JSON.parse(input.decisionContent) as unknown, "decision report");
  if (!Array.isArray(report.candidates)) throw new Error("decision report candidates must be an array.");
  const compiledDecision = report.decision !== null && typeof report.decision === "object" &&
      !Array.isArray(report.decision)
    ? report.decision as JsonObject
    : null;
  const hasExistenceContent = compiledDecision !== null &&
    Object.hasOwn(compiledDecision, "existenceRecordContentSha256");
  const hasVerifiedSha = compiledDecision !== null && Object.hasOwn(compiledDecision, "verifiedOriginMainSha");
  if (hasExistenceContent !== hasVerifiedSha) {
    throw new Error("Decision report carries an incomplete existence binding.");
  }
  const decisionReport: IntakeApprovalDecisionBinding = {
    path: resolve(input.decisionPath),
    contentSha256: sha256Content(input.decisionContent),
    ...(hasExistenceContent && compiledDecision !== null ? {
      existenceRecordContentSha256: sha256(
        compiledDecision.existenceRecordContentSha256,
        "decision report decision.existenceRecordContentSha256",
      ),
      verifiedOriginMainSha: gitSha(
        compiledDecision.verifiedOriginMainSha,
        "decision report decision.verifiedOriginMainSha",
      ),
    } : {}),
  };
  const entries = report.candidates.map((rawCandidate, index): IntakeApprovalEntry => {
    const candidate = object(rawCandidate, `decision report candidate[${index}]`);
    const sourceFingerprint = text(candidate.sourceFingerprint, `candidate[${index}].sourceFingerprint`);
    const presentation = text(candidate.presentation, `candidate[${index}].presentation`);
    if (presentation !== "draft" && presentation !== "hold" && presentation !== "replay_no_op") {
      throw new Error(`candidate[${index}].presentation is unsupported.`);
    }
    if (presentation !== "draft") {
      return {
        decisionReport, sourceFingerprint, presentation, approvable: false, approved: false,
        intendedAction: null, canonicalIssueNumber: null, issue: null, evidenceComment: null,
        intendedActions: [], closeIssue: null, closeBasis: null,
        deniedClassification: [],
        hold: presentation === "hold" ? holdFromCandidate(candidate, `candidate[${index}]`) : null,
        replay: presentation === "replay_no_op" ? replayFromReport(report, sourceFingerprint) : null,
      };
    }
    const draft = object(candidate.draft, `candidate[${index}].draft`);
    const intendedAction = draft.intendedAction;
    if (intendedAction !== "create_issue" && intendedAction !== "append_evidence" && intendedAction !== "append_evidence_overlap") {
      throw new Error(`candidate[${index}] draft has no approvable intended action.`);
    }
    const issue = object(draft.issue, `candidate[${index}].draft.issue`);
    const denied = draft.deniedClassification;
    if (!Array.isArray(denied)) throw new Error(`candidate[${index}].draft.deniedClassification must be an array.`);
    const deniedClassification = denied.map((entry, classificationIndex) =>
      classificationFromDraft(entry, `candidate[${index}].draft.deniedClassification[${classificationIndex}]`));
    const canonicalIssueNumber = draft.canonicalIssueNumber;
    if (canonicalIssueNumber !== null && (!Number.isInteger(canonicalIssueNumber) || (canonicalIssueNumber as number) <= 0)) {
      throw new Error(`candidate[${index}].draft.canonicalIssueNumber must be a positive integer or null.`);
    }
    const rawIntendedActions = draft.intendedActions === undefined ? [intendedAction] : draft.intendedActions;
    if (!Array.isArray(rawIntendedActions) || rawIntendedActions.some((action) =>
      action !== "create_issue" && action !== "append_evidence" && action !== "append_evidence_overlap" && action !== "close_issue" && action !== "close_issue_existence")) {
      throw new Error(`candidate[${index}].draft.intendedActions contains an unsupported action.`);
    }
    const intendedActions = rawIntendedActions as IntakeApprovalEntry["intendedActions"];
    const rawCloseIssue = draft.closeIssue;
    const closeIssue = rawCloseIssue === null || rawCloseIssue === undefined ? null : (() => {
      const close = object(rawCloseIssue, `candidate[${index}].draft.closeIssue`);
      if (close.before !== "OPEN" || close.after !== "CLOSED") {
        throw new Error(`candidate[${index}].draft.closeIssue must transition OPEN to CLOSED.`);
      }
      return {
        targetIssueNumber: positiveInteger(close.targetIssueNumber, `candidate[${index}].draft.closeIssue.targetIssueNumber`),
        before: "OPEN" as const,
        after: "CLOSED" as const,
        evidenceIds: textArray(close.evidenceIds, `candidate[${index}].draft.closeIssue.evidenceIds`),
      };
    })();
    if (intendedAction === "append_evidence_overlap" && canonicalIssueNumber === null) {
      throw new Error(`candidate[${index}] model append requires a canonical issue.`);
    }
    if (closeIssue === null ? sameActions(intendedActions) !== sameActions([intendedAction]) :
        intendedAction !== "append_evidence" || canonicalIssueNumber !== closeIssue.targetIssueNumber ||
        !["close_issue", "close_issue_existence"].some(kind => sameActions(intendedActions) === sameActions(["append_evidence", kind]))) {
      throw new Error(`candidate[${index}] close action must follow evidence append on the canonical issue.`);
    }
    return {
      decisionReport, sourceFingerprint, presentation, approvable: true, approved: false, intendedAction,
      canonicalIssueNumber: canonicalIssueNumber as number | null,
      intendedActions, closeIssue,
      closeBasis: draft.closeBasis == null ? null : text(draft.closeBasis, `candidate[${index}].draft.closeBasis`),
      issue: { title: text(issue.title, `candidate[${index}].draft.issue.title`), body: text(issue.body, `candidate[${index}].draft.issue.body`) },
      evidenceComment: text(draft.evidenceComment, `candidate[${index}].draft.evidenceComment`),
      deniedClassification, hold: null, replay: null,
    };
  });
  if (report.skipped !== undefined && !Array.isArray(report.skipped)) throw new Error("decision report skipped must be an array.");
  const skipped = (report.skipped as unknown[] | undefined ?? []).map((raw, index): IntakeApprovalSkipped => {
    const candidate = object(raw, `decision report skipped[${index}]`);
    if (candidate.status !== "dispositioned") throw new Error(`skipped[${index}] status is unsupported.`);
    if (candidate.draft != null || candidate.approved === true || candidate.approvable === true) throw new Error("Skipped candidates cannot be approved or drafted.");
    return { decisionReport, sourceFingerprint: text(candidate.sourceFingerprint, `skipped[${index}].sourceFingerprint`),
      stableOutcomeId: text(candidate.stableOutcomeId, `skipped[${index}].stableOutcomeId`),
      status: "dispositioned", approvable: false, approved: false };
  });
  const fingerprints = [...entries, ...skipped].map(entry => entry.sourceFingerprint);
  if (new Set(fingerprints).size !== fingerprints.length) throw new Error("Decision report duplicates an active or skipped candidate.");
  return {
    schemaVersion: INTAKE_APPROVAL_PLAN_SCHEMA,
    generatedAt: (input.now ?? new Date()).toISOString(),
    decision: decisionReport,
    decisions: [decisionReport],
    entries,
    ...(report.skipped === undefined ? {} : { skipped }),
  };
}

function sameActions(actions: readonly string[]): string {
  return JSON.stringify(actions);
}

export function buildMergedIntakeApprovalPlan(input: {
  readonly decisions: readonly { readonly path: string; readonly content: string }[];
  readonly now?: Date;
}): IntakeApprovalPlan {
  if (input.decisions.length === 0) throw new Error("Approval generation requires at least one decision report.");
  const plans = input.decisions.map((decision) => buildIntakeApprovalPlan({
    decisionPath: decision.path, decisionContent: decision.content, now: input.now,
  }));
  const decisions = plans.map((plan) => plan.decision);
  const entries = plans.flatMap((plan) => plan.entries);
  const skipped = plans.flatMap(plan => plan.skipped ?? []);
  const identities = [...entries, ...skipped].map((entry) => `${entry.decisionReport.path}\0${entry.sourceFingerprint}`);
  if (new Set(identities).size !== identities.length) throw new Error("Approval inputs duplicate a decision candidate.");
  return {
    schemaVersion: INTAKE_APPROVAL_PLAN_SCHEMA,
    generatedAt: (input.now ?? new Date()).toISOString(),
    decision: decisions[0],
    decisions,
    entries,
    ...(plans.some(plan => plan.skipped !== undefined) ? { skipped } : {}),
  };
}

function parseArguments(argv: readonly string[]): { decisions: string[]; out: string } {
  const decisions: string[] = [];
  let out: string | undefined;
  for (const argument of argv) {
    const match = /^--(decision|out)=(.+)$/.exec(argument);
    if (match === null) throw new Error(`Unsupported argument: ${argument}`);
    if (match[1] === "decision") decisions.push(resolve(match[2]));
    else if (out === undefined) out = resolve(match[2]);
    else throw new Error(`Unsupported or duplicate argument: ${argument}`);
  }
  if (decisions.length === 0 || out === undefined) throw new Error("Approval generation requires --decision=PATH and --out=PATH.");
  return { decisions, out };
}

export function runIntakeApproveCli(input: {
  readonly argv: readonly string[];
  readonly operatorToken?: string;
  readonly now?: Date;
}): IntakeApprovalPlan {
  if (input.operatorToken !== undefined && input.operatorToken.trim() !== "") {
    throw new Error("ROADMAP_SHADOW_PUBLISH_TOKEN must not be present during credential-free approval planning.");
  }
  const args = parseArguments(input.argv);
  const plan = buildMergedIntakeApprovalPlan({
    decisions: args.decisions.map((path) => ({ path, content: readFileSync(path, "utf8") })),
    now: input.now,
  });
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return plan;
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const plan = runIntakeApproveCli({
      argv: process.argv.slice(2),
      operatorToken: process.env.ROADMAP_SHADOW_PUBLISH_TOKEN,
    });
    console.log(`Wrote ${plan.entries.length} approval entr${plan.entries.length === 1 ? "y" : "ies"}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
