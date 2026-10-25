import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ACTION_LABEL_QUESTION_SCHEMA, PANEL_ELIGIBLE_ASSESSMENT_PROVIDERS, actionLabelCaseKey, actionLabelQuestionPaths, currentAssessmentStack, currentAssessmentStackHash, parseActionLabelQuestion, qualifyingActionLabel } from "./lib/github-issue-roadmap/action-qualification";
import { canonicalJson, canonicalJsonSha256, prettyCanonicalJson } from "./lib/github-issue-roadmap/canonical-json";
import {
  INTAKE_OBSERVATION_DIRECTORY,
  INTAKE_OBSERVATION_SCHEMA_V2,
  readIntakeJournalRecord,
  type IntakeObservationRecordV2,
} from "./lib/github-issue-roadmap/intake-observation";
import { parseIntakeSnapshotV1 } from "./lib/github-issue-roadmap/intake-snapshot";
import { renderJudgementMaterialWithVerification, type RenderedJudgementMaterial } from "./lib/github-issue-roadmap/judgement-material";
import {
  actionMaterialRoot,
  parseActionLabel,
  readJudgementRecordRevisions,
  resolveActionJudgementRoot,
  writeJudgementRecord,
  type ActionLabel,
  type JudgementRecord,
  type ModelActionKind,
} from "./lib/github-issue-roadmap/judgement-record";
import { parseOutcomeEnvelope, type OutcomeCandidate } from "./lib/github-issue-roadmap/outcome-candidate";
import { STEWARDSHIP_SEAT_STARTUP_MS, type StewardshipSeat } from "./lib/github-issue-roadmap/stewardship-assessment";
import { createClaudeGlmStewardshipSeats } from "./lib/github-issue-roadmap/stewardship-seats";
import { buildActionLabelJudgementRecord } from "./github-issue-roadmap-judge";

const PANEL_PROMPT_TEMPLATE = "scripts/github-issue-roadmap-label-panel-prompt.md";
const PANEL_TIMEOUT_MS = 300_000;
const PANEL_SCHEMA = "github-issue-roadmap-action-label-panel/v1" as const;
const OUTCOMES = [
  "labeled_correct",
  "labeled_incorrect",
  "question",
  "seat_failed",
  "stale_stack",
  "already_labeled",
  "pending_question",
  "evidence_unverified",
  "limit_reached",
] as const;

type PanelVerdict = "correct" | "incorrect" | "unsure";
type PanelOutcome = typeof OUTCOMES[number];

interface ParsedPanelAnswer {
  readonly verdict: PanelVerdict;
  readonly rationale: string;
}

interface PanelCase {
  readonly observation: IntakeObservationRecordV2;
  readonly actionLabel: ActionLabel;
  readonly materialRoot: string;
}

interface SeatFailure {
  readonly family: StewardshipSeat["family"];
  readonly code: string;
}

export interface LabelPanelSummary {
  readonly counts: Readonly<Record<PanelOutcome, number>>;
  readonly cases: readonly ({
    readonly id: string;
    readonly target: number;
    readonly outcome: PanelOutcome;
    readonly failures?: readonly SeatFailure[];
  })[];
}

interface LabelPanelArguments {
  readonly actionKind: ModelActionKind;
  readonly limit: number;
}

function parseArguments(argv: readonly string[]): LabelPanelArguments {
  let actionKind: ModelActionKind = "append_evidence_overlap";
  let limit = 10;
  const seen = new Set<string>();
  for (const argument of argv) {
    const match = /^--(action-kind|limit)=(.+)$/.exec(argument);
    if (match === null || seen.has(match[1])) throw new Error(`Unsupported or duplicate argument: ${argument}`);
    seen.add(match[1]);
    if (match[1] === "limit") {
      if (!/^[1-9][0-9]*$/.test(match[2]) || !Number.isSafeInteger(Number(match[2]))) {
        throw new Error("--limit= must be a positive integer.");
      }
      limit = Number(match[2]);
    } else {
      if (match[2] !== "append_evidence_overlap" && match[2] !== "close_issue_existence") {
        throw new Error("--action-kind= is unsupported.");
      }
      actionKind = match[2];
    }
  }
  if (actionKind === "close_issue_existence") {
    throw new Error("close_issue_existence suggestions cannot accrue until the zero-satisfied existence probe is fixed (#1987).");
  }
  return { actionKind, limit };
}

function readObservation(materialRoot: string, observationId: string): IntakeObservationRecordV2 {
  const observation = readIntakeJournalRecord(join(materialRoot, INTAKE_OBSERVATION_DIRECTORY, `${observationId}.json`));
  if (observation.schemaVersion !== INTAKE_OBSERVATION_SCHEMA_V2 || observation.observationId !== observationId) {
    throw new Error(`Banked observation ${observationId} does not match its material directory.`);
  }
  return observation;
}

function discoverCases(judgementRoot: string, actionKind: ModelActionKind): PanelCase[] {
  const materialDirectory = join(judgementRoot, "material");
  if (!existsSync(materialDirectory)) return [];
  const cases: PanelCase[] = [];
  for (const entry of readdirSync(materialDirectory, { withFileTypes: true })
    .filter((item) => item.isDirectory() && /^[a-f0-9]{64}$/.test(item.name))
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const materialRoot = actionMaterialRoot(judgementRoot, entry.name);
    const observation = readObservation(materialRoot, entry.name);
    const raw: unknown = JSON.parse(readFileSync(join(materialRoot, "suggestions.json"), "utf8"));
    if (!Array.isArray(raw)) throw new Error(`Banked suggestions for ${entry.name} must be an array.`);
    for (const actionLabel of raw.map(parseActionLabel)
      .filter((item) => item.actionKind === actionKind)
      .sort((left, right) => left.targetIssueNumber - right.targetIssueNumber)) {
      if (actionLabel.sourceFingerprint !== observation.candidate.sourceFingerprint) {
        throw new Error(`Banked suggestion for ${entry.name} does not match its candidate.`);
      }
      cases.push({ observation, actionLabel, materialRoot });
    }
  }
  return cases;
}

function questionPath(judgementRoot: string, item: PanelCase): string {
  return join(judgementRoot, "questions", `${item.observation.observationId}-${item.actionLabel.actionKind}-${item.actionLabel.targetIssueNumber}.json`);
}

// The gate scores one case per finding and target whichever filing run banked it, so the
// runner asks the panel and the operator at most once per case.
function pendingQuestionKeys(judgementRoot: string, stackHash: string): Set<string> {
  return new Set(actionLabelQuestionPaths(judgementRoot)
    .map((path) => parseActionLabelQuestion(JSON.parse(readFileSync(path, "utf8"))))
    .filter((question) => question.assessmentStackSha256 === stackHash)
    .map(actionLabelCaseKey));
}

function alreadyLabeled(records: readonly JudgementRecord[], item: PanelCase, stackHash: string, provider: string): boolean {
  return records.some((record) => {
    const label = qualifyingActionLabel(record, stackHash, provider);
    return label !== undefined && actionLabelCaseKey(label) === actionLabelCaseKey(item.actionLabel);
  });
}

function extractBlindCandidateMaterial(rendered: string): string {
  const candidateHeading = "## Candidate identity\n";
  const comparableHeading = "\n## Comparable issues\n";
  const start = rendered.indexOf(candidateHeading);
  const end = rendered.lastIndexOf(comparableHeading);
  if (start < 0 || end <= start) throw new Error("Rendered material does not contain the blinded candidate sections.");
  return rendered.slice(start, end).trimEnd();
}

function readBoundCandidate(item: PanelCase): OutcomeCandidate {
  const raw: unknown = JSON.parse(readFileSync(resolve(item.materialRoot, item.observation.candidate.locator), "utf8"));
  if (canonicalJsonSha256(raw) !== item.observation.candidate.contentSha256) {
    throw new Error(`Pinned candidate for ${item.observation.observationId} does not match its observation binding.`);
  }
  const envelope = parseOutcomeEnvelope(raw);
  const matches = envelope.candidates.filter(({ sourceFingerprint }) => sourceFingerprint === item.observation.candidate.sourceFingerprint);
  if (matches.length !== 1) throw new Error(`Pinned candidate for ${item.observation.observationId} is missing or ambiguous.`);
  return matches[0];
}

function readBoundTarget(item: PanelCase): { readonly title: string; readonly body: string } {
  const raw: unknown = JSON.parse(readFileSync(resolve(item.materialRoot, item.observation.snapshot.locator), "utf8"));
  const snapshot = parseIntakeSnapshotV1(raw);
  if (snapshot.contentSha256 !== item.observation.snapshot.contentSha256
    || snapshot.candidateSha256 !== item.observation.candidate.contentSha256) {
    throw new Error(`Pinned snapshot for ${item.observation.observationId} does not match its observation bindings.`);
  }
  const target = snapshot.issues.find(({ number }) => number === item.actionLabel.targetIssueNumber);
  if (target === undefined) throw new Error(`Target issue #${item.actionLabel.targetIssueNumber} is absent from the pinned snapshot.`);
  return { title: target.title, body: target.body };
}

function composePrompt(template: string, rendered: RenderedJudgementMaterial, item: PanelCase, target: { readonly title: string; readonly body: string }): string {
  const replacements: Readonly<Record<string, string>> = {
    candidateMaterial: extractBlindCandidateMaterial(rendered.text),
    targetIssueNumber: String(item.actionLabel.targetIssueNumber),
    targetIssueTitle: target.title,
    targetIssueBody: target.body,
  };
  return template.replace(/\{\{([A-Za-z]+)\}\}/g, (_token, name: string) => {
    const replacement = replacements[name];
    if (replacement === undefined) throw new Error(`Unknown panel prompt placeholder: ${name}.`);
    return replacement;
  });
}

function parsePanelAnswer(value: unknown): ParsedPanelAnswer {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("invalid panel response"), { code: "invalid_response" });
  const raw = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify(["rationale", "verdict"])) {
    throw Object.assign(new Error("invalid panel response"), { code: "invalid_response" });
  }
  if (raw.verdict !== "correct" && raw.verdict !== "incorrect" && raw.verdict !== "unsure") {
    throw Object.assign(new Error("invalid panel verdict"), { code: "invalid_verdict" });
  }
  if (typeof raw.rationale !== "string" || raw.rationale.trim() === "") {
    throw Object.assign(new Error("invalid panel rationale"), { code: "invalid_rationale" });
  }
  return { verdict: raw.verdict, rationale: storedRationale(raw.rationale) };
}

/** The record keeps at most 1000 UTF-16 units of a seat's reason. A longer reason still carries a valid
 * verdict, so it is stored with whitespace collapsed and shortened on a code-point boundary;
 * responseSha256 covers exactly the stored answer, so the record can be checked on its own. */
const STORED_RATIONALE_CHARACTERS = 1000;
function storedRationale(rationale: string): string {
  const normalized = rationale.replace(/\s+/g, " ").trim();
  if (normalized.length <= STORED_RATIONALE_CHARACTERS) return normalized;
  let kept = "";
  for (const codePoint of normalized) {
    if (kept.length + codePoint.length > STORED_RATIONALE_CHARACTERS - 1) break;
    kept += codePoint;
  }
  return `${kept.trimEnd()}…`;
}

function diagnosticCode(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const detail = "detail" in error && error.detail !== null && typeof error.detail === "object"
      ? error.detail as Record<string, unknown> : undefined;
    const candidate = detail?.code ?? ("code" in error ? error.code : undefined);
    if (typeof candidate === "string" && /^[a-z0-9_]{1,64}$/.test(candidate)) return candidate;
  }
  return "seat_error";
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function validateAndOrderSeats(seats: readonly StewardshipSeat[]): readonly [StewardshipSeat, StewardshipSeat] {
  if (seats.length !== 2) throw new Error("The panel requires exactly two seats.");
  const anthropic = seats.find((seat) => seat.family === "anthropic");
  const glm = seats.find((seat) => seat.family === "glm");
  if (anthropic === undefined || glm === undefined || anthropic.requestedModel.trim() === "" || glm.requestedModel.trim() === "") {
    throw new Error("The panel requires one configured anthropic seat and one configured glm seat.");
  }
  return [anthropic, glm];
}

function emptyCounts(): Record<PanelOutcome, number> {
  return Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0])) as Record<PanelOutcome, number>;
}

export async function runLabelPanel(input: {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly seats?: readonly [StewardshipSeat, StewardshipSeat];
  readonly now?: () => string;
}): Promise<LabelPanelSummary> {
  const args = parseArguments(input.argv);
  const repoRoot = resolve(input.cwd);
  const provider = currentAssessmentStack(repoRoot).provider;
  if (!(PANEL_ELIGIBLE_ASSESSMENT_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`Refusing panel labeling for the current ${provider} assessment stack; its provider is not allowlisted as cross-family.`);
  }
  const stackHash = currentAssessmentStackHash(repoRoot);
  const judgementRoot = resolveActionJudgementRoot({
    judgementRoot: process.env.ROADMAP_INTAKE_JUDGEMENT_ROOT,
    journalRoot: process.env.ROADMAP_INTAKE_JOURNAL_ROOT,
    homeDirectory: homedir(),
  });
  const labelsRoot = join(judgementRoot, "labels");
  const records = readJudgementRecordRevisions(labelsRoot).map(({ record }) => record);
  const template = readFileSync(join(repoRoot, PANEL_PROMPT_TEMPLATE), "utf8");
  const seats = validateAndOrderSeats(input.seats ?? createClaudeGlmStewardshipSeats());
  const counts = emptyCounts();
  const caseResults: Array<LabelPanelSummary["cases"][number]> = [];
  const pendingKeys = pendingQuestionKeys(judgementRoot, stackHash);
  let sent = 0;

  const finish = (item: PanelCase, outcome: PanelOutcome, failures?: readonly SeatFailure[]) => {
    counts[outcome] += 1;
    caseResults.push({ id: item.observation.observationId, target: item.actionLabel.targetIssueNumber, outcome, ...(failures === undefined ? {} : { failures }) });
  };

  for (const item of discoverCases(judgementRoot, args.actionKind)) {
    if (item.observation.assessmentStackSha256 !== stackHash) {
      finish(item, "stale_stack");
      continue;
    }
    if (alreadyLabeled(records, item, stackHash, provider)) {
      finish(item, "already_labeled");
      continue;
    }
    const pendingPath = questionPath(judgementRoot, item);
    if (pendingKeys.has(actionLabelCaseKey(item.actionLabel))) {
      finish(item, "pending_question");
      continue;
    }
    const rendered = renderJudgementMaterialWithVerification({ repoRoot: item.materialRoot, observationId: item.observation.observationId });
    if (rendered.evidenceVerified !== true) {
      finish(item, "evidence_unverified");
      continue;
    }
    if (sent >= args.limit) {
      finish(item, "limit_reached");
      continue;
    }
    sent += 1;

    const candidate = readBoundCandidate(item);
    const target = readBoundTarget(item);
    const prompt = composePrompt(template, rendered, item, target);
    const promptSha256 = sha256(prompt);
    const settled = await Promise.allSettled(seats.map((seat) => seat.invoke({ prompt, timeoutMs: PANEL_TIMEOUT_MS, startupTimeoutMs: STEWARDSHIP_SEAT_STARTUP_MS, reserve: () => PANEL_TIMEOUT_MS })));
    const failures: SeatFailure[] = [];
    const answers: Array<{
      readonly family: StewardshipSeat["family"];
      readonly requestedModel: string;
      readonly observedModel: string;
      readonly answer: ParsedPanelAnswer;
      readonly responseSha256: string;
    }> = [];
    for (const [index, result] of settled.entries()) {
      const seat = seats[index];
      if (result.status === "rejected") {
        failures.push({ family: seat.family, code: diagnosticCode(result.reason) });
        continue;
      }
      try {
        const answer = parsePanelAnswer(result.value.assessment);
        if (typeof result.value.observedModel !== "string" || result.value.observedModel.trim() === "") {
          throw Object.assign(new Error("invalid observed model"), { code: "invalid_model" });
        }
        answers.push({
          family: seat.family,
          requestedModel: seat.requestedModel,
          observedModel: result.value.observedModel,
          answer,
          // StewardshipSeat exposes parsed assessment but not raw completed output, so this hashes
          // the canonical JSON of the validated parsed answer as required by the fallback contract.
          responseSha256: sha256(canonicalJson(answer)),
        });
      } catch (error) {
        failures.push({ family: seat.family, code: diagnosticCode(error) });
      }
    }
    if (failures.length > 0) {
      finish(item, "seat_failed", failures);
      continue;
    }

    const [left, right] = answers;
    if (left.answer.verdict !== "unsure" && left.answer.verdict === right.answer.verdict) {
      const verdict = left.answer.verdict;
      const actionLabel = { ...item.actionLabel, verdict };
      const judgedAt = (input.now ?? (() => new Date().toISOString()))();
      const record = buildActionLabelJudgementRecord({
        observation: item.observation,
        actionLabel,
        judgedBy: "model_panel",
        judgedAt,
        rendered,
        extensions: {
          panel: {
            schemaVersion: PANEL_SCHEMA,
            promptSha256,
            seats: answers.map(({ family, requestedModel, observedModel, answer, responseSha256 }) => ({
              family,
              requestedModel,
              observedModel,
              verdict: answer.verdict,
              rationale: answer.rationale,
              responseSha256,
            })),
          },
        },
      });
      writeJudgementRecord({ judgementRoot: labelsRoot, record });
      records.push(record);
      finish(item, verdict === "correct" ? "labeled_correct" : "labeled_incorrect");
      continue;
    }

    const createdAt = (input.now ?? (() => new Date().toISOString()))();
    const question = {
      schemaVersion: ACTION_LABEL_QUESTION_SCHEMA,
      assessmentStackSha256: item.observation.assessmentStackSha256,
      observationId: item.observation.observationId,
      actionKind: item.actionLabel.actionKind,
      targetIssueNumber: item.actionLabel.targetIssueNumber,
      repository: item.actionLabel.repository,
      sourceFingerprint: item.actionLabel.sourceFingerprint,
      candidateTitle: candidate.outcome.title,
      targetIssueTitle: target.title,
      question: `Is "${candidate.outcome.title}" the same outcome as #${item.actionLabel.targetIssueNumber} "${target.title}"?`,
      createdAt,
      seatVerdicts: answers.map(({ family, answer }) => ({ family, verdict: answer.verdict })),
    };
    mkdirSync(join(judgementRoot, "questions"), { recursive: true });
    writeFileSync(pendingPath, prettyCanonicalJson(question), { flag: "wx" });
    pendingKeys.add(actionLabelCaseKey(item.actionLabel));
    finish(item, "question");
  }

  return { counts, cases: caseResults };
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  runLabelPanel({ argv: process.argv.slice(2), cwd: process.cwd() })
    .then((summary) => console.log(prettyCanonicalJson(summary)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
