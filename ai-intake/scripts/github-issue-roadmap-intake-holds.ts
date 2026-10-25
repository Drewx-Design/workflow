import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { INTAKE_APPROVAL_PLAN_SCHEMA } from "./github-issue-roadmap-intake-approve";
import { INTAKE_DRAIN_MANIFEST_SCHEMA } from "./github-issue-roadmap-intake-drain";
import { atomicDrainWrite, readIntakeRuns, type RunState } from "./lib/github-issue-roadmap/intake-drain-admission";

export const HOLD_RESOLUTION_SCHEMA = "github-issue-roadmap-intake-hold-resolution/v1" as const;
export const DEFAULT_DRAINS_ROOT = "artifacts/github-issue-roadmap/drains";
export const DEFAULT_HOLD_RESOLUTION_LOG = "artifacts/github-issue-roadmap/hold-resolutions.jsonl";

type JsonObject = Record<string, unknown>;
export type HoldResolutionKind = "accepted-existing" | "resubmitted" | "override";

export interface UnresolvedIntakeHold {
  readonly runState?: RunState["status"];
  readonly quarantinedSidecarPaths?: readonly string[];
  readonly runId: string;
  readonly runDate: string;
  readonly sourceFingerprint: string;
  readonly sourceLocator: string;
  readonly decisionContentSha256: string;
  readonly reason: string;
  readonly rationale: string;
  readonly competingIssueNumbers: readonly number[];
}

export interface IntakeHoldResolution {
  readonly schemaVersion: typeof HOLD_RESOLUTION_SCHEMA;
  readonly decisionContentSha256: string;
  readonly sourceFingerprint: string;
  readonly resolvedAt: string;
  readonly outcome: HoldResolutionKind;
  readonly acceptedExistingIssueNumber: number | null;
  readonly resubmittedSidecar: string | null;
}

function object(value: unknown, context: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} must be an object.`);
  return value as JsonObject;
}

function text(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${context} must be non-empty text.`);
  return value;
}

function sha256(value: unknown, context: string): string {
  const parsed = text(value, context);
  if (!/^[a-f0-9]{64}$/i.test(parsed)) throw new Error(`${context} must be a SHA-256 hash.`);
  return parsed.toLowerCase();
}

function positiveInteger(value: unknown, context: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${context} must be a positive integer.`);
  return value as number;
}

function readJson(path: string, context: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    throw new Error(`${context} ${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolutionKey(decisionContentSha256: string, sourceFingerprint: string): string {
  return `${decisionContentSha256}\0${sourceFingerprint}`;
}

function parseResolution(value: unknown, context: string): IntakeHoldResolution {
  const record = object(value, context);
  if (record.schemaVersion !== HOLD_RESOLUTION_SCHEMA) throw new Error(`${context}.schemaVersion is unsupported.`);
  const outcome = text(record.outcome, `${context}.outcome`);
  if (outcome !== "accepted-existing" && outcome !== "resubmitted" && outcome !== "override") {
    throw new Error(`${context}.outcome is unsupported.`);
  }
  const acceptedExistingIssueNumber = record.acceptedExistingIssueNumber === null
    ? null : positiveInteger(record.acceptedExistingIssueNumber, `${context}.acceptedExistingIssueNumber`);
  const resubmittedSidecar = record.resubmittedSidecar === null
    ? null : text(record.resubmittedSidecar, `${context}.resubmittedSidecar`);
  if ((outcome === "accepted-existing") !== (acceptedExistingIssueNumber !== null)) {
    throw new Error(`${context} has inconsistent accepted-existing details.`);
  }
  if ((outcome === "resubmitted") !== (resubmittedSidecar !== null)) {
    throw new Error(`${context} has inconsistent resubmitted details.`);
  }
  return {
    schemaVersion: HOLD_RESOLUTION_SCHEMA,
    decisionContentSha256: sha256(record.decisionContentSha256, `${context}.decisionContentSha256`),
    sourceFingerprint: text(record.sourceFingerprint, `${context}.sourceFingerprint`),
    resolvedAt: text(record.resolvedAt, `${context}.resolvedAt`), outcome,
    acceptedExistingIssueNumber, resubmittedSidecar,
  };
}

function readResolutions(path: string): IntakeHoldResolution[] {
  if (!existsSync(path)) return [];
  let content: string;
  try { content = readFileSync(path, "utf8"); }
  catch (error) { throw new Error(`Hold resolution log ${path} is unreadable: ${error instanceof Error ? error.message : String(error)}`); }
  return content.split(/\r?\n/).filter((line) => line.trim() !== "").map((line, index) => {
    try { return parseResolution(JSON.parse(line) as unknown, `Hold resolution log ${path} line ${index + 1}`); }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error(`Hold resolution log ${path} line ${index + 1} is unreadable: ${error.message}`);
      throw error;
    }
  });
}

function validateDispositionFiles(processedDirectory: string): void {
  if (!existsSync(processedDirectory)) return;
  let names: string[];
  try { names = readdirSync(processedDirectory).filter((name) => name.endsWith(".dispositions.json")); }
  catch (error) { throw new Error(`Processed drain directory ${processedDirectory} is unreadable: ${error instanceof Error ? error.message : String(error)}`); }
  for (const name of names) {
    const path = join(processedDirectory, name);
    const disposition = object(readJson(path, "Drain disposition"), `Drain disposition ${path}`);
    if (!Array.isArray(disposition.candidates)) throw new Error(`Drain disposition ${path}.candidates must be an array.`);
    disposition.candidates.forEach((candidate, index) => {
      const parsed = object(candidate, `Drain disposition ${path}.candidates[${index}]`);
      text(parsed.sourceFingerprint, `Drain disposition ${path}.candidates[${index}].sourceFingerprint`);
      const presentation = text(parsed.presentation, `Drain disposition ${path}.candidates[${index}].presentation`);
      if (presentation !== "draft" && presentation !== "hold" && presentation !== "replay_no_op") {
        throw new Error(`Drain disposition ${path}.candidates[${index}].presentation is unsupported.`);
      }
    });
  }
}

function resolveManifestPath(runRoot: string, value: unknown, context: string): string {
  const path = text(value, context);
  return isAbsolute(path) ? path : resolve(runRoot, path);
}

function readRunHolds(runRoot: string): UnresolvedIntakeHold[] {
  const manifestPath = join(runRoot, "manifest.json");
  const manifest = object(readJson(manifestPath, "Drain manifest"), `Drain manifest ${manifestPath}`);
  if (manifest.schemaVersion !== INTAKE_DRAIN_MANIFEST_SCHEMA) throw new Error(`Drain manifest ${manifestPath}.schemaVersion is unsupported.`);
  const runId = text(manifest.runId, `Drain manifest ${manifestPath}.runId`);
  const runDate = text(manifest.preparedAt, `Drain manifest ${manifestPath}.preparedAt`);
  if (Number.isNaN(Date.parse(runDate))) throw new Error(`Drain manifest ${manifestPath}.preparedAt must be a date.`);
  const processedDirectory = resolveManifestPath(runRoot, manifest.processedDirectory, `Drain manifest ${manifestPath}.processedDirectory`);
  validateDispositionFiles(processedDirectory);
  if (!Array.isArray(manifest.envelopes)) throw new Error(`Drain manifest ${manifestPath}.envelopes must be an array.`);
  const sourceLocators = new Map<string, string>();
  manifest.envelopes.forEach((rawEnvelope, envelopeIndex) => {
    const envelope = object(rawEnvelope, `Drain manifest ${manifestPath}.envelopes[${envelopeIndex}]`);
    if (!Array.isArray(envelope.queueEntries)) throw new Error(`Drain manifest ${manifestPath}.envelopes[${envelopeIndex}].queueEntries must be an array.`);
    envelope.queueEntries.forEach((rawQueue, queueIndex) => {
      const queue = object(rawQueue, `Drain manifest ${manifestPath}.envelopes[${envelopeIndex}].queueEntries[${queueIndex}]`);
      const locator = text(queue.sourceLocator, `Drain manifest ${manifestPath}.envelopes[${envelopeIndex}].queueEntries[${queueIndex}].sourceLocator`);
      if (!Array.isArray(queue.sourceFingerprints)) throw new Error(`Drain manifest ${manifestPath}.envelopes[${envelopeIndex}].queueEntries[${queueIndex}].sourceFingerprints must be an array.`);
      queue.sourceFingerprints.forEach((fingerprint, fingerprintIndex) => {
        const parsed = text(fingerprint, `Drain manifest ${manifestPath}.envelopes[${envelopeIndex}].queueEntries[${queueIndex}].sourceFingerprints[${fingerprintIndex}]`);
        const existing = sourceLocators.get(parsed);
        if (existing !== undefined && existing !== locator) throw new Error(`Drain manifest ${manifestPath} maps fingerprint ${parsed} to multiple source locators.`);
        sourceLocators.set(parsed, locator);
      });
    });
  });

  const planPath = resolveManifestPath(runRoot, manifest.approvalPlanPath, `Drain manifest ${manifestPath}.approvalPlanPath`);
  const plan = object(readJson(planPath, "Drain approval plan"), `Drain approval plan ${planPath}`);
  if (plan.schemaVersion !== INTAKE_APPROVAL_PLAN_SCHEMA) throw new Error(`Drain approval plan ${planPath}.schemaVersion is unsupported.`);
  if (!Array.isArray(plan.entries)) throw new Error(`Drain approval plan ${planPath}.entries must be an array.`);
  return plan.entries.flatMap((rawEntry, index): UnresolvedIntakeHold[] => {
    const entry = object(rawEntry, `Drain approval plan ${planPath}.entries[${index}]`);
    const presentation = text(entry.presentation, `Drain approval plan ${planPath}.entries[${index}].presentation`);
    if (presentation !== "draft" && presentation !== "hold" && presentation !== "replay_no_op") {
      throw new Error(`Drain approval plan ${planPath}.entries[${index}].presentation is unsupported.`);
    }
    if (presentation !== "hold") return [];
    const sourceFingerprint = text(entry.sourceFingerprint, `Drain approval plan ${planPath}.entries[${index}].sourceFingerprint`);
    const sourceLocator = sourceLocators.get(sourceFingerprint);
    if (sourceLocator === undefined) throw new Error(`Drain approval plan ${planPath} hold ${sourceFingerprint} has no source artifact locator in ${manifestPath}.`);
    const decisionReport = object(entry.decisionReport, `Drain approval plan ${planPath}.entries[${index}].decisionReport`);
    const hold = object(entry.hold, `Drain approval plan ${planPath}.entries[${index}].hold`);
    if (!Array.isArray(hold.competingIssueNumbers)) throw new Error(`Drain approval plan ${planPath}.entries[${index}].hold.competingIssueNumbers must be an array.`);
    return [{
      runId, runDate, sourceFingerprint, sourceLocator,
      decisionContentSha256: sha256(decisionReport.contentSha256, `Drain approval plan ${planPath}.entries[${index}].decisionReport.contentSha256`),
      reason: text(hold.reason, `Drain approval plan ${planPath}.entries[${index}].hold.reason`),
      rationale: text(hold.rationale, `Drain approval plan ${planPath}.entries[${index}].hold.rationale`),
      competingIssueNumbers: hold.competingIssueNumbers.map((number, issueIndex) =>
        positiveInteger(number, `Drain approval plan ${planPath}.entries[${index}].hold.competingIssueNumbers[${issueIndex}]`)),
    }];
  });
}

function runStateHold(run: Exclude<RunState, { status: "finished" }>): UnresolvedIntakeHold {
  const paths = run.status === "abandoned" ? run.receipt.sidecars.map((entry) => entry.quarantinedPath) : [];
  return {
    runState: run.status, runId: run.runId,
    runDate: run.status === "unfinished" ? run.admission.preparedAt : "unknown date",
    sourceFingerprint: `run:${run.runId}`, sourceLocator: run.runDir,
    decisionContentSha256: "no decision", competingIssueNumbers: [], quarantinedSidecarPaths: paths,
    reason: run.status === "corrupt" ? "corrupt run, needs manual attention"
      : run.status === "abandoned" ? `abandoned: ${run.receipt.reason}`
      : run.status === "unfinished" ? "preparation in progress" : "empty run, needs manual attention",
    rationale: run.status === "corrupt" ? run.reason
      : run.status === "abandoned" ? `${run.reason.trim()} Retained admission: ${run.receipt.quarantinedPath}`
      : run.status === "unfinished" ? "Retained admission will be retried by intake drain prepare." : "No committed admission or manifest.",
  };
}

export function listIntakeHolds(input: {
  readonly repoRoot?: string; readonly drainsRoot?: string; readonly resolutionLogPath?: string;
} = {}): UnresolvedIntakeHold[] {
  const repoRoot = resolve(input.repoRoot ?? process.cwd());
  const drainsRoot = resolve(repoRoot, input.drainsRoot ?? DEFAULT_DRAINS_ROOT);
  const resolutionLogPath = resolve(repoRoot, input.resolutionLogPath ?? DEFAULT_HOLD_RESOLUTION_LOG);
  const inventory = readIntakeRuns(drainsRoot);
  if (inventory.status === "unavailable") throw new Error(`Intake admission inventory unavailable: ${inventory.reason}`);
  const resolved = new Set(readResolutions(resolutionLogPath).map((record) =>
    resolutionKey(record.decisionContentSha256, record.sourceFingerprint)));
  return inventory.runs.flatMap((run): UnresolvedIntakeHold[] => {
    if (run.status !== "finished") return [runStateHold(run)];
    try { return readRunHolds(run.runDir); }
    catch (error) {
      return [runStateHold({ ...run, status: "corrupt", reason: error instanceof Error ? error.message : String(error) })];
    }
  })
    .filter((hold) => hold.runState !== undefined || !resolved.has(resolutionKey(hold.decisionContentSha256, hold.sourceFingerprint)))
    .sort((left, right) => left.runDate.localeCompare(right.runDate)
      || left.runId.localeCompare(right.runId) || left.sourceFingerprint.localeCompare(right.sourceFingerprint));
}

export function formatIntakeHoldList(holds: readonly UnresolvedIntakeHold[]): string {
  if (holds.length === 0) return "No unresolved roadmap intake holds.\nTotal: 0";
  const blocks = holds.map((hold) => [
    `${hold.runDate}  ${hold.runId}`,
    `  source fingerprint: ${hold.sourceFingerprint}`,
    `  decision hash: ${hold.decisionContentSha256}`,
    `  source artifact: ${hold.sourceLocator}`,
    `  competing issues: ${hold.competingIssueNumbers.length === 0 ? "none named" : hold.competingIssueNumbers.map((number) => `#${number}`).join(", ")}`,
    `  reason: ${hold.reason}`,
    `  rationale: ${hold.rationale}`,
    ...(hold.quarantinedSidecarPaths ?? []).map((path) => `  quarantined sidecar: ${path}`),
  ].join("\n"));
  return `Unresolved roadmap intake holds\n\n${blocks.join("\n\n")}\n\nTotal: ${holds.length}`;
}

export function resolveIntakeHold(input: {
  readonly repoRoot?: string; readonly drainsRoot?: string; readonly resolutionLogPath?: string;
  readonly decisionContentSha256: string; readonly sourceFingerprint: string; readonly outcome: HoldResolutionKind | string;
  readonly acceptedExistingIssueNumber?: number; readonly resubmittedSidecar?: string; readonly now?: Date;
}): IntakeHoldResolution {
  if (input.outcome !== "accepted-existing" && input.outcome !== "resubmitted" && input.outcome !== "override") {
    throw new Error(`Unsupported hold resolution kind: ${input.outcome}.`);
  }
  const repoRoot = resolve(input.repoRoot ?? process.cwd());
  const resolutionLogPath = resolve(repoRoot, input.resolutionLogPath ?? DEFAULT_HOLD_RESOLUTION_LOG);
  const allHolds = listIntakeHolds({ repoRoot, drainsRoot: input.drainsRoot, resolutionLogPath });
  const decisionContentSha256 = sha256(input.decisionContentSha256, "decisionContentSha256");
  const sourceFingerprint = text(input.sourceFingerprint, "sourceFingerprint");
  const hold = allHolds.find((candidate) => candidate.decisionContentSha256 === decisionContentSha256
    && candidate.sourceFingerprint === sourceFingerprint);
  if (hold === undefined) throw new Error(`Unknown or already resolved hold: ${decisionContentSha256}/${sourceFingerprint}.`);
  const acceptedExistingIssueNumber = input.outcome === "accepted-existing"
    ? positiveInteger(input.acceptedExistingIssueNumber, "acceptedExistingIssueNumber") : null;
  if (acceptedExistingIssueNumber !== null && !hold.competingIssueNumbers.includes(acceptedExistingIssueNumber)) {
    throw new Error(`Issue #${acceptedExistingIssueNumber} is not named as a competing issue for this hold.`);
  }
  const resubmittedSidecar = input.outcome === "resubmitted"
    ? text(input.resubmittedSidecar, "resubmittedSidecar") : null;
  if (input.outcome !== "accepted-existing" && input.acceptedExistingIssueNumber !== undefined) {
    throw new Error("--issue is valid only for accepted-existing resolutions.");
  }
  if (input.outcome !== "resubmitted" && input.resubmittedSidecar !== undefined) {
    throw new Error("--sidecar is valid only for resubmitted resolutions.");
  }
  const record: IntakeHoldResolution = {
    schemaVersion: HOLD_RESOLUTION_SCHEMA, decisionContentSha256, sourceFingerprint,
    resolvedAt: (input.now ?? new Date()).toISOString(), outcome: input.outcome,
    acceptedExistingIssueNumber, resubmittedSidecar,
  };
  mkdirSync(dirname(resolutionLogPath), { recursive: true });
  const previous = existsSync(resolutionLogPath) ? readFileSync(resolutionLogPath, "utf8") : "";
  atomicDrainWrite(resolutionLogPath, `${previous}${JSON.stringify(record)}\n`);
  return record;
}

function argumentsMap(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (match === null || values.has(match[1])) throw new Error(`Unsupported or duplicate argument: ${argument}`);
    values.set(match[1], match[2]);
  }
  return values;
}

export function runIntakeHoldsCli(input: { readonly argv: readonly string[]; readonly repoRoot?: string; readonly now?: Date }): string {
  const [command, ...rest] = input.argv;
  const values = argumentsMap(rest);
  const common = { repoRoot: input.repoRoot, drainsRoot: values.get("drains"), resolutionLogPath: values.get("resolution-log") };
  if (command === "list") return formatIntakeHoldList(listIntakeHolds(common));
  if (command !== "resolve") throw new Error("Intake holds requires command list or resolve.");
  const decisionContentSha256 = values.get("decision-hash");
  const sourceFingerprint = values.get("fingerprint");
  const outcome = values.get("outcome");
  if (decisionContentSha256 === undefined || sourceFingerprint === undefined || outcome === undefined) {
    throw new Error("Hold resolve requires --decision-hash=SHA256, --fingerprint=VALUE, and --outcome=KIND.");
  }
  const issueValue = values.get("issue");
  const record = resolveIntakeHold({
    ...common, decisionContentSha256, sourceFingerprint, outcome,
    acceptedExistingIssueNumber: issueValue === undefined ? undefined : Number(issueValue),
    resubmittedSidecar: values.get("sidecar"), now: input.now,
  });
  return `Recorded ${record.outcome} for ${record.sourceFingerprint}.`;
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  try { console.log(runIntakeHoldsCli({ argv: process.argv.slice(2) })); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
