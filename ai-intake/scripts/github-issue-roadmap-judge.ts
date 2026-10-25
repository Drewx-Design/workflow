import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDispatcherCapabilityManifest } from "./lib/github-issue-roadmap/capability-manifest";
import { prettyCanonicalJson } from "./lib/github-issue-roadmap/canonical-json";
import { runCredentialCleanGit } from "./lib/github-issue-roadmap/credential-clean-git";
import { ACTION_LABEL_SET_DIRECTORY, readActionQualification, summarizeActionLabels, type ActionLabelScore, type ActionQualificationContext } from "./lib/github-issue-roadmap/action-qualification";
import {
  INTAKE_MATCH_RESULTS,
  type IntakeMatchResult,
} from "./lib/github-issue-roadmap/intake-assessment";
import { INTAKE_CALIBRATION_SCORING_VERSION } from "./lib/github-issue-roadmap/intake-decision";
import {
  INTAKE_OBSERVATION_DIRECTORY,
  INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION,
  INTAKE_OBSERVATION_SCHEMA_V2,
  readIntakeJournalRecord,
  type IntakeObservationRecordV2,
} from "./lib/github-issue-roadmap/intake-observation";
import * as judgementMaterial from "./lib/github-issue-roadmap/judgement-material";
import {
  JUDGEMENT_RECORD_DIRECTORY,
  JUDGEMENT_ACTORS,
  buildJudgementRecord,
  readJudgementRecords,
  readJudgementRecordRevisions,
  summarizeJudgements,
  writeJudgementRecord,
  type JudgementRecord,
  type JudgementReadout,
  type JudgementRecordInput,
  actionMaterialRoot,
  MODEL_ACTION_KINDS,
  parseActionLabel,
  resolveActionJudgementRoot as resolveJudgementRoot,
  type ActionLabel,
} from "./lib/github-issue-roadmap/judgement-record";

export function resolveActionJudgementRoot(): string {
  return resolveJudgementRoot({ judgementRoot: process.env.ROADMAP_INTAKE_JUDGEMENT_ROOT,
    journalRoot: process.env.ROADMAP_INTAKE_JOURNAL_ROOT, homeDirectory: homedir() });
}

/** Host-only acquisition. The compiler receives data, never a Git/credential callback. */
export function loadActionQualificationContext(repoRoot: string, runGit = runCredentialCleanGit, originMainSha?: string): ActionQualificationContext {
  const committedLabelSets: Record<string, Buffer | null> = {};
  const revocationLabelSets: Record<string, Buffer | null> = {};
  const context = { repoRoot, judgementRoot: resolveActionJudgementRoot(), committedLabelSets, revocationLabelSets };
  try {
    const sha = originMainSha ?? runGit(repoRoot, ["rev-parse", "--verify", "origin/main^{commit}"], { localObjectsOnly: true });
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid origin/main commit.");
    const manifestBytes = Buffer.from(runGit(repoRoot, ["show", `${sha}:scripts/github-issue-roadmap-capabilities.json`],
      { output: "base64", localObjectsOnly: true }), "base64");
    const manifest = parseDispatcherCapabilityManifest(JSON.parse(manifestBytes.toString("utf8")));
    for (const kind of MODEL_ACTION_KINDS) {
      try {
        committedLabelSets[kind] = Buffer.from(runGit(repoRoot, ["show", `${sha}:${ACTION_LABEL_SET_DIRECTORY}/${kind}.json`], { output: "base64", localObjectsOnly: true }), "base64");
      } catch {
        // Missing/unreadable merged evidence can never grant authority.
        committedLabelSets[kind] = null;
      }
      try {
        // Local commits may revoke authority, but only origin/main can grant it.
        revocationLabelSets[kind] = Buffer.from(runGit(repoRoot, ["show", `HEAD:${ACTION_LABEL_SET_DIRECTORY}/${kind}.json`], { output: "base64", localObjectsOnly: true }), "base64");
      } catch { revocationLabelSets[kind] = null; }
    }
    return { ...context, manifest };
  } catch {
    // Never substitute the working-tree manifest when merged authority is unavailable.
    return { ...context, manifest: null };
  }
}

const ARGUMENT = /^--(judgement-root|record|observation-id|judged-match|judged-by|judged-at|sensitive-action-automatic|routine-eligible|split|action-kind|target-issue|action-verdict)=(.+)$/;
const OBSERVATION_ARGUMENTS = [
  "observation-id",
  "judged-match",
  "judged-by",
  "judged-at",
  "sensitive-action-automatic",
  "routine-eligible",
  "split",
  "action-kind", "target-issue", "action-verdict",
] as const;
const JUDGEMENT_SPLITS = ["tuning", "holdout", "shadow", "regression"] as const;

interface Arguments {
  readonly judgementRoot: string;
  readonly record: string | null;
  readonly observationId: string | null;
  readonly judgedMatch: IntakeMatchResult | null;
  readonly judgedBy: JudgementRecordInput["judgedBy"] | null;
  readonly judgedAt: string | null;
  readonly sensitiveActionAutomatic: boolean | null;
  readonly routineEligible: boolean | null;
  readonly split: JudgementRecordInput["split"];
  readonly actionKind: ActionLabel["actionKind"] | null;
  readonly targetIssueNumber: number | null;
  readonly actionVerdict: ActionLabel["verdict"] | null;
}

function booleanArgument(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${name}= must be true or false.`);
}

function enumArgument<T extends string>(value: string, allowed: readonly T[], name: string): T {
  if (!allowed.includes(value as T)) throw new Error(`--${name}= is unsupported.`);
  return value as T;
}

function timestampArgument(value: string, name: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`--${name}= must be an ISO timestamp.`);
  return value;
}

function parseArguments(argv: readonly string[]): Arguments {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = ARGUMENT.exec(argument);
    if (match === null || values.has(match[1])) throw new Error(`Unsupported or duplicate argument: ${argument}`);
    values.set(match[1], match[2]);
  }
  const record = values.get("record") ?? null;
  const observationId = values.get("observation-id") ?? null;
  const suppliedObservationArguments = OBSERVATION_ARGUMENTS.filter((name) => values.has(name));
  if (record !== null && suppliedObservationArguments.length > 0) {
    throw new Error("The --record= path does not accept observation arguments.");
  }
  if (observationId === null && suppliedObservationArguments.length > 0) {
    const name = suppliedObservationArguments[0];
    throw new Error(
      `Unsupported or duplicate argument outside the observation path: --${name}=${values.get(name)}.`,
    );
  }
  if (observationId !== null) {
    for (const name of (values.has("action-kind") ? ["judged-by", "judged-at", "target-issue", "action-verdict"] : ["judged-match", "judged-by", "sensitive-action-automatic", "judged-at"])) {
      if (!values.has(name)) throw new Error(`--${name}= is required with --observation-id=.`);
    }
  }
  if (!values.has("action-kind") && (values.has("target-issue") || values.has("action-verdict"))) throw new Error("--action-kind= is required for action labels.");
  if (values.has("action-kind") && values.has("split") && values.get("split") !== "holdout") throw new Error("Action labels require --split=holdout.");
  if (values.has("target-issue") && (!/^[1-9][0-9]*$/.test(values.get("target-issue")!) || !Number.isSafeInteger(Number(values.get("target-issue"))))) throw new Error("--target-issue= must be a positive integer.");
  if (values.has("action-kind") && values.has("judgement-root") && resolve(values.get("judgement-root")!) !== join(resolveActionJudgementRoot(), "labels")) throw new Error("Action labels must use the shared store; relocate it with ROADMAP_INTAKE_JUDGEMENT_ROOT.");
  return {
    judgementRoot: values.has("action-kind") ? join(resolveActionJudgementRoot(), "labels") : values.get("judgement-root") ?? JUDGEMENT_RECORD_DIRECTORY,
    actionKind: values.has("action-kind") ? enumArgument(values.get("action-kind")!, MODEL_ACTION_KINDS, "action-kind") : null,
    targetIssueNumber: values.has("target-issue") ? Number(values.get("target-issue")) : null,
    actionVerdict: values.has("action-verdict") ? enumArgument(values.get("action-verdict")!, ["correct", "incorrect"] as const, "action-verdict") : null,
    record,
    observationId,
    judgedMatch: values.has("judged-match")
      ? enumArgument(values.get("judged-match")!, INTAKE_MATCH_RESULTS, "judged-match")
      : null,
    judgedBy: values.has("judged-by")
      ? enumArgument(values.get("judged-by")!, JUDGEMENT_ACTORS, "judged-by")
      : null,
    judgedAt: values.has("judged-at")
      ? timestampArgument(values.get("judged-at")!, "judged-at")
      : null,
    sensitiveActionAutomatic: values.has("sensitive-action-automatic")
      ? booleanArgument(values.get("sensitive-action-automatic")!, "sensitive-action-automatic")
      : null,
    routineEligible: values.has("routine-eligible")
      ? booleanArgument(values.get("routine-eligible")!, "routine-eligible")
      : null,
    split: values.has("action-kind") ? "holdout" : values.has("split")
      ? enumArgument(values.get("split")!, JUDGEMENT_SPLITS, "split")
      : "shadow",
  };
}

function readObservation(cwd: string, observationId: string): IntakeObservationRecordV2 {
  if (!/^[a-f0-9]{64}$/.test(observationId)) {
    throw new Error("--observation-id= must be a lowercase SHA-256.");
  }
  const path = resolve(cwd, INTAKE_OBSERVATION_DIRECTORY, `${observationId}.json`);
  const observation = readIntakeJournalRecord(path);
  if (observation.schemaVersion !== INTAKE_OBSERVATION_SCHEMA_V2) {
    throw new Error(`Observation ${observationId} does not carry action operands.`);
  }
  if (observation.observationId !== observationId) {
    throw new Error(`Observation ${observationId} does not match the identity it carries.`);
  }
  return observation;
}

export interface JudgeCliResult {
  readonly recorded: { readonly path: string; readonly created: boolean } | null;
  readonly readout: JudgementReadout;
  /** Labeling progress for the displayed stack; this is not a committed authority grant. */
  readonly actionReadout?: { readonly actionKind: ActionLabel["actionKind"]; readonly assessmentStackSha256: string; readonly score: ActionLabelScore };
}

function buildRenderedJudgementMaterial(
  rendered: judgementMaterial.RenderedJudgementMaterial,
  agrees: boolean,
): JudgementRecordInput["renderedMaterial"] {
  const materialSha256 = createHash("sha256").update(rendered.text, "utf8").digest("hex");
  const verificationFreshness = {
    trustedMarkerWithinRecencyWindow: null,
    trustedMarkerBoundToSnapshotOriginMainSha: null,
  } as const;
  return agrees
    ? {
        materialSha256,
        rendererVersion: judgementMaterial.JUDGEMENT_MATERIAL_RENDERER_VERSION,
        textCapture: "agreement_not_captured",
        verificationFreshness,
      }
    : {
        materialSha256,
        rendererVersion: judgementMaterial.JUDGEMENT_MATERIAL_RENDERER_VERSION,
        textCapture: "disagreement_captured",
        text: rendered.text,
        verificationFreshness,
      };
}

/** Build an action label from the same banked observation material for every authorized writer. */
export function buildActionLabelJudgementRecord(input: {
  readonly observation: IntakeObservationRecordV2;
  readonly actionLabel: ActionLabel;
  readonly judgedBy: JudgementRecordInput["judgedBy"];
  readonly judgedAt: string;
  readonly rendered: judgementMaterial.RenderedJudgementMaterial;
  readonly routineEligible?: boolean | null;
  readonly sensitiveActionAutomatic?: boolean;
  readonly extensions?: JudgementRecordInput["extensions"];
}): JudgementRecord {
  return buildJudgementRecord({
    observationId: input.observation.observationId,
    judgedMatch: input.observation.observedMatch,
    judgedBy: input.judgedBy,
    judgedAt: input.judgedAt,
    scoringVersion: INTAKE_CALIBRATION_SCORING_VERSION,
    split: "holdout",
    observed: {
      producerKind: input.observation.producerKind,
      observedMatch: input.observation.observedMatch,
      ...(input.observation.operandDerivationVersion === INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION
        ? { observedActions: input.observation.actionOperands.map(({ action }) => action) } : {}),
      observedDisposition: input.observation.observedDisposition,
      routineEligible: input.routineEligible ?? null,
      sensitiveActionAutomatic: input.sensitiveActionAutomatic ?? false,
      assessmentStackSha256: input.observation.assessmentStackSha256,
      observedAt: input.observation.observedAt,
    },
    renderedMaterial: buildRenderedJudgementMaterial(input.rendered, input.actionLabel.verdict === "correct"),
    extensions: {
      ...(input.extensions ?? {}),
      evidenceVerified: input.rendered.evidenceVerified,
      actionLabel: input.actionLabel,
    },
  });
}

/**
 * Record at most one judgement, then emit the accuracy readout over the whole store.
 *
 * The readout holds no authority and gates nothing (KD1): it is a working signal the operator reads.
 */
export function runJudgeCli(input: {
  readonly argv: readonly string[];
  readonly cwd: string;
}): JudgeCliResult {
  const args = parseArguments(input.argv);
  const requireCliActor = (actor: JudgementRecordInput["judgedBy"] | null) => {
    if (actor === "model_panel") throw new Error("model_panel records must be written by the panel runner.");
    if (actor === "human_operator" && process.stdin.isTTY !== true) throw new Error("--judged-by=human_operator requires interactive stdin.");
  };
  requireCliActor(args.judgedBy);
  const cwd = resolve(input.cwd);
  const judgementRoot = resolve(cwd, args.judgementRoot);
  let recorded: JudgeCliResult["recorded"] = null;
  let actionReadout: JudgeCliResult["actionReadout"];
  if (args.record !== null) {
    const raw = JSON.parse(readFileSync(resolve(cwd, args.record), "utf8")) as JudgementRecordInput;
    requireCliActor(raw.judgedBy);
    if (raw.extensions?.actionLabel !== undefined) throw new Error("Action labels must be recorded from shared observation material with --action-kind=.");
    const written = writeJudgementRecord({ judgementRoot, record: buildJudgementRecord(raw) });
    recorded = { path: written.path, created: written.created };
  }
  if (args.observationId !== null) {
    const materialRoot = args.actionKind === null ? cwd : actionMaterialRoot(resolveActionJudgementRoot(), args.observationId);
    const observation = readObservation(materialRoot, args.observationId);
    let actionLabel: ActionLabel | undefined;
    if (args.actionKind !== null) {
      const raw: unknown = JSON.parse(readFileSync(join(materialRoot, "suggestions.json"), "utf8"));
      if (!Array.isArray(raw)) throw new Error("Shared action suggestions must be an array.");
      const suggestion = raw.map(parseActionLabel).find(item => item.actionKind === args.actionKind && item.targetIssueNumber === args.targetIssueNumber);
      if (suggestion === undefined || suggestion.sourceFingerprint !== observation.candidate.sourceFingerprint) throw new Error("Action label does not match a banked suggestion and target.");
      actionLabel = { ...suggestion, verdict: args.actionVerdict! };
    }
    if (Date.parse(args.judgedAt!) < Date.parse(observation.observedAt)) {
      throw new Error(
        `--judged-at=${args.judgedAt} must be on or after observation observedAt=${observation.observedAt}.`,
      );
    }
    const rendered = judgementMaterial.renderJudgementMaterialWithVerification({
      repoRoot: materialRoot,
      observationId: observation.observationId,
    });
    process.stdout.write(rendered.text);
    if (actionLabel !== undefined) process.stdout.write(`\nSuggested ${actionLabel.actionKind} to #${actionLabel.targetIssueNumber}: ${actionLabel.verdict}\n`);
    const record = actionLabel === undefined ? buildJudgementRecord({
      observationId: observation.observationId,
      judgedMatch: args.judgedMatch!,
      judgedBy: args.judgedBy!,
      judgedAt: args.judgedAt!,
      scoringVersion: INTAKE_CALIBRATION_SCORING_VERSION,
      split: args.split,
      observed: {
        producerKind: observation.producerKind,
        observedMatch: observation.observedMatch,
        ...(observation.operandDerivationVersion === INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION
          ? { observedActions: observation.actionOperands.map(({ action }) => action) } : {}),
        observedDisposition: observation.observedDisposition,
        routineEligible: args.routineEligible,
        sensitiveActionAutomatic: args.sensitiveActionAutomatic ?? false,
        assessmentStackSha256: observation.assessmentStackSha256,
        observedAt: observation.observedAt,
      },
      renderedMaterial: buildRenderedJudgementMaterial(rendered, args.judgedMatch === observation.observedMatch),
      extensions: { evidenceVerified: rendered.evidenceVerified },
    }) : buildActionLabelJudgementRecord({
      observation,
      actionLabel,
      judgedBy: args.judgedBy!,
      judgedAt: args.judgedAt!,
      rendered,
      routineEligible: args.routineEligible,
      sensitiveActionAutomatic: args.sensitiveActionAutomatic ?? false,
    });
    const written = writeJudgementRecord({ judgementRoot, record });
    recorded = { path: written.path, created: written.created };
    if (actionLabel !== undefined) {
      actionReadout = { actionKind: actionLabel.actionKind, assessmentStackSha256: observation.assessmentStackSha256,
        score: summarizeActionLabels(readJudgementRecordRevisions(judgementRoot).map(item => item.record),
          actionLabel.actionKind, actionLabel.repository, observation.assessmentStackSha256) };
    }
  }
  return { recorded, readout: summarizeJudgements(readJudgementRecords(judgementRoot)), ...(actionReadout === undefined ? {} : { actionReadout }) };
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv.length === 3 && process.argv[2] === "--action-qualification") {
      const context = loadActionQualificationContext(process.cwd());
      console.log(prettyCanonicalJson(MODEL_ACTION_KINDS.map(kind => readActionQualification(kind, context))));
    } else console.log(prettyCanonicalJson(runJudgeCli({ argv: process.argv.slice(2), cwd: process.cwd() })));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
