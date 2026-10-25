import { createHash, randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runExistenceProbeCli } from "./github-issue-roadmap-existence-probe";
import { runIntakePreflightCli } from "./github-issue-roadmap-intake-preflight";
import {
  buildMergedIntakeApprovalPlan, type IntakeApprovalEntry, type IntakeApprovalPlan,
} from "./github-issue-roadmap-intake-approve";
import { runOperatorAssessmentRequestCli } from "./github-issue-roadmap-operator-assessment-request";
import { runPreflightCli } from "./github-issue-roadmap-preflight";
import { parseRoadmapProducerRegistry, type RoadmapProducerRegistry } from "./lint-roadmap-outcome-candidates";
import { AUTOMATIC_INTAKE_LIMITS } from "./lib/github-issue-roadmap/capability-manifest";
import { canonicalJsonSha256, prettyCanonicalJson } from "./lib/github-issue-roadmap/canonical-json";
import { runCredentialCleanGit } from "./lib/github-issue-roadmap/credential-clean-git";
import { dispositionHistory, effectiveOutcomeCandidates, type DispositionHistory } from "./lib/github-issue-roadmap/disposition-history";
import { intakeAssessmentSha256, intakeDispositionSkips, parseIntakeAssessment, type IntakeDispositionSkip } from "./lib/github-issue-roadmap/intake-assessment";
import { compileIntakeDecision } from "./lib/github-issue-roadmap/intake-decision";
import type { IntakeShadowReport } from "./lib/github-issue-roadmap/intake-shadow";
import { inWorkingDirectory } from "./lib/github-issue-roadmap/in-working-directory";
import {
  INTAKE_DRAIN_ADMISSION_SCHEMA, readIntakeRuns, classifyRun, assertPathWithin, atomicDrainWrite,
  TerminalAdmissionError, TransientAdmissionError, type IntakeDrainAdmission, type IntakeAdmissionTree,
} from "./lib/github-issue-roadmap/intake-drain-admission";
import { runIntakeShadow } from "./lib/github-issue-roadmap/intake-shadow";
import { buildRunEvidence, verifyRunEvidence } from "./lib/github-issue-roadmap/intake-run-evidence";
import { intakeSnapshotJson, parseIntakeSnapshotV1, type IntakeSnapshotV1 } from "./lib/github-issue-roadmap/intake-snapshot";
import {
  createOutcomeEnvelope, outcomeEnvelopeJson, outcomeSourceContentMatchesSha256, parseOutcomeEnvelope,
  type OutcomeCandidate, type OutcomeCandidateMaterial, type OutcomeEnvelope,
} from "./lib/github-issue-roadmap/outcome-candidate";

export const INTAKE_DRAIN_MANIFEST_SCHEMA = "github-issue-roadmap-intake-drain/v1" as const;
const INTAKE_DRAIN_AUTHORED_REQUEST_SCHEMA = "github-issue-roadmap-intake-drain-authored-request/v1" as const;
export const DEFAULT_INTAKE_QUEUE = "artifacts/github-issue-roadmap/queue";
export { TerminalAdmissionError, TransientAdmissionError } from "./lib/github-issue-roadmap/intake-drain-admission";
export const MAX_ADMISSION_ATTEMPTS = 5;
export const MAX_ADMISSION_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_ABANDONMENTS_PER_INVOCATION = 1;
export const DEFAULT_INTAKE_REPOSITORY = "example-org/example-repo";
const DRAIN_IDENTITY_HEX_LENGTH = 12;
const COLLECT_LOCK_NAME = ".collect.lock";
const COLLECT_LOCK_STALE_MS = 5 * 60 * 1000;

interface DrainQueueEntry {
  readonly path: string;
  readonly contentSha256: string;
  readonly sourceLocator: string;
  readonly declaredProducerKind: string;
  readonly producerKind: string;
  readonly correction: { readonly from: string; readonly to: string } | null;
  readonly sourceFingerprints: readonly string[];
}

export interface IntakeDrainQuarantinedEntry {
  // Pending recovery diagnostics retain the run/admission in place (all paths equal).
  // Their reason is inline; they do not claim a quarantine copy or reason file exists.
  readonly originalPath: string;
  readonly quarantinedPath: string;
  readonly reasonPath: string;
  readonly reason: string;
}

export interface IntakeDrainEnvelope {
  readonly index: number;
  readonly candidatePath: string;
  readonly intakeSnapshotPath: string;
  readonly exchangeRoot: string;
  readonly bundlePath: string;
  readonly assessmentTarget: string;
  readonly decisionPath: string;
  readonly queueEntries: readonly DrainQueueEntry[];
}

export interface IntakeDrainManifest {
  readonly schemaVersion: typeof INTAKE_DRAIN_MANIFEST_SCHEMA;
  readonly runId: string;
  readonly preparedAt: string;
  readonly admissionTree?: IntakeAdmissionTree;
  readonly queueDirectory: string;
  readonly stackPath: string;
  readonly snapshots: { readonly canonical: string; readonly intake: string };
  readonly approvalPlanPath: string;
  readonly runEvidencePath?: string;
  readonly runEvidenceSha256?: string;
  readonly processedDirectory: string;
  readonly quarantinedEntries: readonly IntakeDrainQuarantinedEntry[];
  readonly sidecarDivergences?: readonly { readonly path: string; readonly admittedSha256: string; readonly currentSha256: string }[];
  readonly envelopes: readonly IntakeDrainEnvelope[];
  readonly skipped?: readonly IntakeDispositionSkip[];
  readonly skippedEnvelopes?: readonly { readonly candidatePath: string; readonly queueEntries: readonly DrainQueueEntry[] }[];
}

export interface IntakeDrainDependencies {
  readonly captureSnapshots: (input: {
    readonly repoRoot: string; readonly candidatePath: string;
    readonly canonicalPath: string; readonly intakePath: string; readonly repository: string;
  }) => void;
  readonly authorRequest: (input: {
    readonly repoRoot: string; readonly candidatePath: string; readonly intakeSnapshotPath: string;
    readonly stackPath: string; readonly exchangeRoot: string; readonly runDiscriminator: string;
  }) => { readonly bundlePath: string; readonly assessmentTarget: string };
  readonly runShadow: (input: {
    readonly repoRoot: string; readonly candidatePath: string; readonly intakeSnapshotPath: string;
    readonly assessmentPath: string; readonly decisionPath: string; readonly existencePath: string;
    readonly dispositionHistory?: typeof dispositionHistory;
  }) => void;
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(path: string, context: string): unknown {
  const bytes = readAdmissionFile(path);
  try { return JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new TerminalAdmissionError(`${context} ${path} is unparseable: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}

function parseJsonBytes(bytes: Buffer, path: string, context: string): unknown {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch (error) { throw new TerminalAdmissionError(`${context} ${path} is unparseable: ${error instanceof Error ? error.message : String(error)}`); }
}

function writeOnce(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    if (!readAdmissionFile(path).equals(Buffer.from(content))) throw new TerminalAdmissionError(`Existing drain artifact differs: ${path}`);
    return;
  }
  atomicDrainWrite(path, content);
}

function quarantineQueueEntry(queueDirectory: string, path: string, reason: string): IntakeDrainQuarantinedEntry {
  const quarantineDirectory = join(queueDirectory, "quarantine");
  mkdirSync(quarantineDirectory, { recursive: true });
  const filename = basename(path);
  const stem = filename.endsWith(".json") ? filename.slice(0, -".json".length) : filename;
  const extension = filename.endsWith(".json") ? ".json" : "";
  let suffix = 1;
  let quarantinedPath = join(quarantineDirectory, filename);
  let reasonPath = `${quarantinedPath}.reason.txt`;
  while (existsSync(quarantinedPath) || existsSync(reasonPath)) {
    suffix += 1;
    quarantinedPath = join(quarantineDirectory, `${stem}--${suffix}${extension}`);
    reasonPath = `${quarantinedPath}.reason.txt`;
  }
  atomicDrainWrite(reasonPath, `${reason}\n`);
  renameSync(path, quarantinedPath);
  return { originalPath: path, quarantinedPath, reasonPath, reason };
}

function globRegex(glob: string): RegExp {
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") { index += 1; pattern += glob[index + 1] === "/" ? (index += 1, "(?:.*/)?") : ".*"; }
    else if (char === "*") pattern += "[^/]*";
    else if (char === "{") {
      const close = glob.indexOf("}", index);
      if (close < 0) throw new Error(`Invalid producer glob ${glob}.`);
      pattern += `(?:${glob.slice(index + 1, close).split(",").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
      index = close;
    } else pattern += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${pattern}$`);
}

function producerKindFor(sourceLocator: string, registry: RoadmapProducerRegistry): OutcomeEnvelope["producer"]["kind"] {
  const matches = registry.producers.filter((producer) => producer.active && producer.artifactGlobs.some((glob) => globRegex(glob).test(sourceLocator)));
  if (matches.length !== 1) throw new Error(`Queue source ${sourceLocator} must match exactly one active producer registry entry.`);
  return matches[0].kind;
}

function materialCandidates(envelope: OutcomeEnvelope): OutcomeCandidateMaterial[] {
  return envelope.candidates.map(({ sourceFingerprint: _fingerprint, emissionContentSha256: _emission, ...material }) => material);
}

function correctedEnvelope(raw: unknown, registry: RoadmapProducerRegistry): {
  readonly envelope: OutcomeEnvelope; readonly declared: string; readonly correction: DrainQueueEntry["correction"];
} {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Queue sidecar must contain an envelope object.");
  const record = raw as Record<string, unknown>;
  const artifact = record.artifact as Record<string, unknown> | undefined;
  const producer = record.producer as Record<string, unknown> | undefined;
  if (typeof artifact?.sourceLocator !== "string" || typeof producer?.kind !== "string") throw new Error("Queue sidecar lacks source or producer identity.");
  const kind = producerKindFor(artifact.sourceLocator, registry);
  const declared = producer.kind;
  if (declared === kind) return { envelope: parseOutcomeEnvelope(raw), declared, correction: null };
  if (!Array.isArray(record.candidates)) throw new Error("Queue sidecar candidates must be an array.");
  const candidates = record.candidates.map((candidate) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Queue candidate must be an object.");
    const material = { ...candidate } as Record<string, unknown>;
    delete material.sourceFingerprint;
    delete material.emissionContentSha256;
    return material;
  });
  const envelope = createOutcomeEnvelope({ ...record, producer: { ...producer, kind }, candidates });
  return { envelope, declared, correction: { from: declared, to: kind } };
}

function mergeEnvelopes(entries: readonly { readonly queue: DrainQueueEntry; readonly envelope: OutcomeEnvelope }[], history: DispositionHistory): {
  readonly envelope: OutcomeEnvelope; readonly queueEntries: readonly DrainQueueEntry[];
}[] {
  const groups = new Map<string, typeof entries[number][]>();
  for (const entry of entries) {
    const key = JSON.stringify({
      schemaVersion: entry.envelope.schemaVersion,
      repository: entry.envelope.repository, producer: entry.envelope.producer, artifact: entry.envelope.artifact,
    });
    const group = groups.get(key) ?? [];
    group.push(entry); groups.set(key, group);
  }
  const output: { envelope: OutcomeEnvelope; queueEntries: DrainQueueEntry[] }[] = [];
  for (const group of groups.values()) {
    let candidates: OutcomeCandidate[] = [];
    let queueEntries: DrainQueueEntry[] = [];
    const flush = () => {
      if (candidates.length === 0) return;
      const base = group[0].envelope;
      const envelope = createOutcomeEnvelope({ ...base, candidates: materialCandidates({ ...base, candidates }) });
      output.push({ envelope, queueEntries }); candidates = []; queueEntries = [];
    };
    for (const entry of group) {
      for (const candidate of entry.envelope.candidates) {
        const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
        if (candidateBytes > AUTOMATIC_INTAKE_LIMITS.maxCandidateBytes) throw new Error(`Candidate ${candidate.sourceFingerprint} from ${entry.queue.path} exceeds 16 KiB.`);
        const next = [...candidates, candidate];
        const base = entry.envelope;
        const nextEnvelope = createOutcomeEnvelope({ ...base, candidates: materialCandidates({ ...base, candidates: next }) });
        if (effectiveOutcomeCandidates(nextEnvelope, history).active.length > AUTOMATIC_INTAKE_LIMITS.maxEnvelopeCandidates || Buffer.byteLength(JSON.stringify(nextEnvelope), "utf8") > AUTOMATIC_INTAKE_LIMITS.maxEnvelopeBytes) {
          flush();
          const single = createOutcomeEnvelope({ ...base, candidates: materialCandidates({ ...base, candidates: [candidate] }) });
          if (Buffer.byteLength(JSON.stringify(single), "utf8") > AUTOMATIC_INTAKE_LIMITS.maxEnvelopeBytes) throw new Error(`Candidate ${candidate.sourceFingerprint} from ${entry.queue.path} cannot fit an envelope.`);
        }
        candidates.push(candidate);
        if (!queueEntries.includes(entry.queue)) queueEntries.push(entry.queue);
      }
    }
    flush();
  }
  const seenFingerprints = new Set<string>();
  for (const { envelope } of output) {
    for (const { sourceFingerprint } of envelope.candidates) {
      if (seenFingerprints.has(sourceFingerprint)) {
        throw new Error(`Duplicate source fingerprint ${sourceFingerprint} appears in more than one merged envelope.`);
      }
      seenFingerprints.add(sourceFingerprint);
    }
  }
  return output;
}

function retainedSnapshot(path: string): IntakeSnapshotV1 {
  const value = readJson(path, "Shared intake snapshot");
  try { return parseIntakeSnapshotV1(value); }
  catch (error) { throw new TerminalAdmissionError(`Invalid retained snapshot: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}

function rebindSnapshot(sharedPath: string, envelope: OutcomeEnvelope, outputPath: string): void {
  const shared = retainedSnapshot(sharedPath);
  const candidateSha256 = canonicalJsonSha256(envelope);
  const core = {
    candidateSha256, canonicalSnapshotV2Sha256: shared.canonicalSnapshotV2Sha256,
    repository: shared.repository, censusContentSha256: shared.censusContentSha256,
    issues: shared.issues, markerIndex: shared.markerIndex, markerIncidents: shared.markerIncidents,
    projectObservation: shared.projectObservation, receipts: shared.receipts,
  };
  const rebound: IntakeSnapshotV1 = { ...shared, candidateSha256, contentSha256: canonicalJsonSha256(core) };
  writeOnce(outputPath, intakeSnapshotJson(rebound));
}

interface IntakeDrainSnapshotRunners {
  readonly runPreflightCli: typeof runPreflightCli;
  readonly runIntakePreflightCli: typeof runIntakePreflightCli;
}

/** The subprocess adapter owns process/HTTP outcome classification. Only direct,
 * explicit exit/status results are deterministic; missing executables, signals and
 * opaque wrappers remain transient under the retry bound. */
function commandAdmissionStep<T>(step: () => T): T {
  try { return step(); }
  catch (error) {
    if (error instanceof TerminalAdmissionError || error instanceof TransientAdmissionError) throw error;
    const result = error as { status?: unknown; signal?: unknown } | null;
    const status = result?.status;
    const deterministic = result?.signal == null && typeof status === "number" && status > 0 &&
      status !== 408 && status !== 429 && status < 500;
    const Failure = deterministic ? TerminalAdmissionError : TransientAdmissionError;
    throw new Failure(error instanceof Error ? error.message : String(error), { cause: error });
  }
}

export function defaultDependencies(runners: IntakeDrainSnapshotRunners = {
  runPreflightCli,
  runIntakePreflightCli,
}, readHistory = dispositionHistory): IntakeDrainDependencies {
  return {
    captureSnapshots: ({ repoRoot, candidatePath, canonicalPath, intakePath, repository }) => {
      commandAdmissionStep(() => inWorkingDirectory(repoRoot, () => runners.runPreflightCli([
        `--repo=${repository}`, `--out=${canonicalPath}`, "--snapshot-version=v2",
      ])));
      commandAdmissionStep(() => runners.runIntakePreflightCli([
        `--candidate=${candidatePath}`, `--snapshot=${canonicalPath}`, `--out=${intakePath}`,
      ], repoRoot));
    },
    authorRequest: ({ repoRoot, candidatePath, intakeSnapshotPath, stackPath, exchangeRoot, runDiscriminator }) => {
      const output = commandAdmissionStep(() => runOperatorAssessmentRequestCli({ cwd: repoRoot, argv: [
        `--candidate=${candidatePath}`, `--intake-snapshot=${intakeSnapshotPath}`,
        `--exchange-root=${exchangeRoot}`, `--stack=${stackPath}`, `--run-discriminator=${runDiscriminator}`,
      ] }));
      const value = (label: string) => output.split("\n").find((line) => line.startsWith(`${label}: `))?.slice(label.length + 2);
      const bundlePath = value("Bundle"); const assessmentTarget = value("Assessment target");
      if (bundlePath === undefined || assessmentTarget === undefined) throw new TerminalAdmissionError("Operator request did not return its bundle paths.");
      return { bundlePath, assessmentTarget };
    },
    runShadow: ({ repoRoot, candidatePath, intakeSnapshotPath, assessmentPath, decisionPath, existencePath, dispositionHistory: historyLookup = readHistory }) => {
      let existence: ReturnType<typeof runExistenceProbeCli>;
      try {
        existence = runExistenceProbeCli([
          `--candidate=${candidatePath}`, `--out=${existencePath}`,
        ], repoRoot, undefined, { dispositionHistory: historyLookup });
        const failures = existence.entries.flatMap((entry) => "runOutcome" in entry
          ? [`${entry.sourceFingerprint}: ${entry.runOutcome.kind}`] : []);
        if (failures.length > 0) throw new Error(failures.join(", "));
      } catch (error) {
        throw new Error(`existence_probe_failed: Could not capture ${candidatePath} at ${existencePath}. ` +
          `Check origin/main, repository read access and run-root write access, then retry collect. ` +
          `${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      // The probe resolves origin/main itself and pins every read to that commit. Do not
      // resolve the moving ref again or reuse a record captured during prepare.
      runIntakeShadow({ repoRoot, candidate: candidatePath, snapshot: intakeSnapshotPath, assessment: assessmentPath,
        out: decisionPath, existence: existencePath, verifiedOriginMainSha: existence.originMainSha, dispositionHistory: historyLookup });
    },
  };
}

interface AuthoredDrainRequest {
  readonly bundlePath: string;
  readonly assessmentTarget: string;
}

function parsedAuthoredRequest(value: unknown, context: string): AuthoredDrainRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TerminalAdmissionError(`${context} must be an object.`);
  const record = value as Record<string, unknown>;
  if (typeof record.bundlePath !== "string" || typeof record.assessmentTarget !== "string") {
    throw new TerminalAdmissionError(`${context} lacks its authored bundle paths.`);
  }
  return { bundlePath: record.bundlePath, assessmentTarget: record.assessmentTarget };
}

function pathIsWithin(root: string, path: string): boolean {
  const fromRoot = relative(resolve(root), resolve(path));
  return fromRoot !== "" && !isAbsolute(fromRoot) && fromRoot !== ".." &&
    !fromRoot.startsWith(`..\\`) && !fromRoot.startsWith("../");
}

function assertAuthoredRequestPaths(root: string, authored: AuthoredDrainRequest, context: string): void {
  if (!pathIsWithin(root, authored.bundlePath) || !pathIsWithin(root, authored.assessmentTarget)) {
    throw new TerminalAdmissionError(`${context} paths must remain inside their drain exchange.`);
  }
  assertPathWithin(root, authored.bundlePath);
  assertPathWithin(root, authored.assessmentTarget);
}

function reusableAuthoredRequest(exchangeRoot: string, authoredPath: string): AuthoredDrainRequest | undefined {
  if (existsSync(authoredPath)) {
    const value = readJson(authoredPath, "Drain authored request") as Record<string, unknown>;
    if (value.schemaVersion !== INTAKE_DRAIN_AUTHORED_REQUEST_SCHEMA) {
      throw new TerminalAdmissionError(`Drain authored request ${authoredPath} has an unsupported schema.`);
    }
    const authored = parsedAuthoredRequest(value, `Drain authored request ${authoredPath}`);
    assertAuthoredRequestPaths(exchangeRoot, authored, `Drain authored request ${authoredPath}`);
    return authored;
  }

  // Older partial prepares predate the drain-local receipt. Recover their completed operator
  // handoff directly, then checkpoint it so subsequent retries take the normal path.
  const sessionsRoot = join(exchangeRoot, "sessions");
  if (!existsSync(sessionsRoot)) return undefined;
  const sessions = readdirSync(sessionsRoot).filter((name) => statSync(join(sessionsRoot, name)).isDirectory());
  if (sessions.length === 0) return undefined;
  if (sessions.length !== 1) throw new TerminalAdmissionError(`Drain exchange ${exchangeRoot} contains multiple operator sessions.`);
  const handoffPath = join(sessionsRoot, sessions[0], "operator-handoff.json");
  if (!existsSync(handoffPath)) return undefined;
  const handoff = readJson(handoffPath, "Operator assessment handoff") as Record<string, unknown>;
  if (handoff.schemaVersion !== "github-issue-roadmap-operator-assessment-handoff/v1" || handoff.runId !== sessions[0]) {
    throw new TerminalAdmissionError(`Operator assessment handoff ${handoffPath} has invalid identity.`);
  }
  if (typeof handoff.exchangeRoot !== "string" || relative(resolve(exchangeRoot), resolve(handoff.exchangeRoot)) !== "") {
    throw new TerminalAdmissionError(`Operator assessment handoff ${handoffPath} belongs to a different exchange.`);
  }
  const authored = parsedAuthoredRequest(handoff, `Operator assessment handoff ${handoffPath}`);
  assertAuthoredRequestPaths(join(sessionsRoot, sessions[0]), authored, `Operator assessment handoff ${handoffPath}`);
  writeOnce(authoredPath, prettyCanonicalJson({ schemaVersion: INTAKE_DRAIN_AUTHORED_REQUEST_SCHEMA, ...authored }));
  return authored;
}

function checkpointAuthoredRequest(authoredPath: string, authored: AuthoredDrainRequest): void {
  writeOnce(authoredPath, prettyCanonicalJson({ schemaVersion: INTAKE_DRAIN_AUTHORED_REQUEST_SCHEMA, ...authored }));
}

export function intakeDrainEnvelopeIdentity(queueIdentity: string, envelopeIndex: number): {
  readonly runId: string;
  readonly runDiscriminator: string;
} {
  if (!/^[a-f0-9]{64}$/.test(queueIdentity)) throw new Error("Drain queue identity must be a lowercase SHA-256.");
  if (!Number.isSafeInteger(envelopeIndex) || envelopeIndex < 1) {
    throw new Error("Drain envelope index must be a positive integer.");
  }
  const runId = `d-${queueIdentity.slice(0, DRAIN_IDENTITY_HEX_LENGTH)}`;
  return { runId, runDiscriminator: `${runId}-${envelopeIndex}` };
}

interface PrepareIntakeDrainInput {
  readonly dispositionHistory?: typeof dispositionHistory;
  readonly repoRoot?: string; readonly queueDirectory?: string; readonly stackPath: string;
  readonly repository?: string;
  readonly now?: Date; readonly dependencies?: IntakeDrainDependencies;
  readonly readQueueFile?: (path: string) => Buffer;
  readonly runGit?: typeof runCredentialCleanGit;
  readonly allowDirtyAdmission?: boolean;
}

/** A sufficient, deliberately conservative test of agreement with a clean checkout
 * of HEAD. Index-only or admission-neutral edits can refuse; unrelated edits cannot.
 * Provenance is descriptive, not read by admission. The producer registry is read.
 */
function inspectAdmissionTree(input: PrepareIntakeDrainInput, repoRoot: string, queueDirectory: string,
  queued: ReadonlyMap<string, { bytes: Buffer } | { error: unknown }>, reservedPaths: ReadonlySet<string>): IntakeAdmissionTree {
  const runGit = input.runGit ?? runCredentialCleanGit;
  try {
    const commitSha = runGit(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commitSha)) throw new Error("HEAD did not resolve to a commit SHA.");
    const relevant = new Set<string>();
    const addPath = (locator: unknown) => {
      if (typeof locator !== "string") return;
      const path = resolve(repoRoot, locator);
      if (!pathIsWithin(repoRoot, path)) return; // Invalid locators still follow normal quarantine.
      relevant.add(admissionPath(repoRoot, path));
      if (existsSync(path)) {
        const physical = realpathSync(path);
        if (pathIsWithin(repoRoot, physical)) relevant.add(admissionPath(repoRoot, physical));
      }
    };
    addPath("scripts/github-issue-roadmap-producers.json");
    for (const [path, read] of queued) {
      addPath(path);
      if (!("bytes" in read)) continue;
      let raw;
      try { raw = JSON.parse(read.bytes.toString("utf8")); }
      catch { continue; } // An unchanged malformed sidecar is still quarantined as before.
      addPath(raw?.artifact?.sourceLocator);
      if (!Array.isArray(raw?.candidates)) continue;
      for (const candidate of raw.candidates) {
        if (Array.isArray(candidate?.evidence)) {
          for (const evidence of candidate.evidence) addPath(evidence?.sourceLocator);
        }
      }
    }
    // Disable rename folding so both old and new paths are checked. NUL framing
    // preserves spaces, newlines and non-ASCII names; the shared runner trims the
    // initial worktree-only status space, hence the one-or-two-character prefix.
    const status = runGit(repoRoot, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=none"]);
    const changes = new Map<string, { path: string; status: string }>();
    for (const record of status.split("\0").filter(Boolean)) {
      const match = /^([ MADRCU?!T]{1,2}) ([\s\S]+)$/.exec(record);
      if (match === null) throw new Error("Git returned an unreadable status record.");
      const path = match[2];
      changes.set(path, { path, status: match[1].padStart(2, " ") });
      // Deleted/renamed-away sidecars are absent from readdir, but alter the set.
      const absolute = resolve(repoRoot, path);
      if (dirname(absolute) === queueDirectory && path.endsWith(".json") && !reservedPaths.has(absolute)) addPath(path);
    }
    const admissionRelevantPaths = [...relevant].sort();
    // Include ignored, untracked inputs without walking unrelated ignored trees
    // (node_modules, run artifacts). Literal pathspecs avoid glob interpretation.
    for (let index = 0; index < admissionRelevantPaths.length; index += 50) {
      const others = runGit(repoRoot, ["--literal-pathspecs", "ls-files", "--others", "-z", "--", ...admissionRelevantPaths.slice(index, index + 50)]);
      for (const path of others.split("\0").filter(Boolean)) changes.set(path, { path, status: "??" });
    }
    const key = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
    const relevantKeys = admissionRelevantPaths.map(key);
    const ordered = [...changes.values()].sort((left, right) => left.path.localeCompare(right.path));
    const affectsAdmission = ({ path }: { path: string }) => relevantKeys.some((entry) => entry === key(path) || entry.startsWith(`${key(path)}/`));
    const relevantChanges = ordered.filter(affectsAdmission);
    return {
      commitSha, admissionRelevantPaths, admissionClean: relevantChanges.length === 0,
      allowDirtyAdmission: input.allowDirtyAdmission === true,
      scheduleEquivalent: relevantChanges.length === 0 && input.allowDirtyAdmission !== true,
      relevantChanges, unrelatedChanges: ordered.filter((entry) => !affectsAdmission(entry)),
    };
  } catch (error) {
    throw new Error(`admission_tree_unavailable: Cannot establish the admission tree. Check Git and repository read access, then retry prepare. ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export function prepareIntakeDrain(input: PrepareIntakeDrainInput): IntakeDrainManifest {
  const repoRoot = resolve(input.repoRoot ?? process.cwd());
  const queueDirectory = resolve(repoRoot, input.queueDirectory ?? DEFAULT_INTAKE_QUEUE);
  const drainsRoot = join(repoRoot, "artifacts/github-issue-roadmap/drains");
  const target = { repoRoot, queueDirectory, stackPath: resolve(repoRoot, input.stackPath), repository: input.repository ?? DEFAULT_INTAKE_REPOSITORY };
  assertPathWithin(repoRoot, queueDirectory);
  const inventory = readIntakeRuns(drainsRoot, target);
  if (inventory.status === "unavailable") throw new Error(`Intake admission inventory unavailable: ${inventory.reason}`);
  const history = (input.dispositionHistory ?? dispositionHistory)("origin/main", { repoRoot, runGit: input.runGit });
  assertPathWithin(repoRoot, drainsRoot);
  const runDiagnostics: IntakeDrainQuarantinedEntry[] = [];
  const failures: string[] = [];
  let abandonmentCount = 0;
  // Runs from other configured queues are diagnostic holds, never authority to move files.
  // Reservations cover only work attempted in this invocation. Old receipts never reserve paths.
  const reservedPaths = new Set<string>();
  for (const run of inventory.runs) {
    if (run.status === "corrupt") {
      const reason = `Corrupt intake run ${run.runId}, needs manual attention: ${run.reason}`;
      console.error(reason);
      failures.push(reason);
      runDiagnostics.push({ originalPath: run.runDir, quarantinedPath: run.runDir, reasonPath: run.runDir, reason });
    }
    if (run.status !== "unfinished") continue;
    run.admission.queueEntries.forEach((entry) => reservedPaths.add(resolve(repoRoot, entry.path)));
  }
  let recovered: IntakeDrainManifest | undefined;
  const publish = (manifest: IntakeDrainManifest, additional: readonly IntakeDrainQuarantinedEntry[] = []): IntakeDrainManifest => {
    const entries = [...(manifest.quarantinedEntries ?? []), ...additional, ...runDiagnostics];
    const unique = [...new Map(entries.map((entry) => [JSON.stringify(entry), entry])).values()];
    const result = { ...manifest, quarantinedEntries: unique };
    if (prettyCanonicalJson(result) !== prettyCanonicalJson(manifest)) {
      atomicDrainWrite(join(dirname(manifest.approvalPlanPath), "manifest.json"), prettyCanonicalJson(result));
    }
    return result;
  };
  for (const run of inventory.runs) {
    if (run.status !== "unfinished") continue;
    console.error(`Unfinished intake admission: ${run.runId}`);
    const outcome = attemptAdmission(input, run.admission, () => { abandonmentCount += 1; }, abandonmentCount < MAX_ABANDONMENTS_PER_INVOCATION);
    if (outcome.manifest !== undefined) recovered = outcome.manifest;
    if (outcome.abandoned !== undefined) runDiagnostics.push(outcome.abandoned);
    if (outcome.failure !== undefined) {
      failures.push(outcome.failure);
      const path = join(run.runDir, "admission.json");
      runDiagnostics.push({ originalPath: path, quarantinedPath: path, reasonPath: path,
        reason: `Recovery pending for ${run.runId}: ${outcome.failure}` });
    }
  }
  if (recovered !== undefined) return publish(recovered);
  if (!existsSync(queueDirectory)) throw new Error(`Intake queue does not exist: ${queueDirectory}`);
  const stackPath = resolve(repoRoot, input.stackPath);
  if (!existsSync(stackPath) || !statSync(stackPath).isFile()) throw new Error(`Assessment stack is missing: ${stackPath}`);
  // Publication contract: producers write a sibling temporary name that does not end in `.json`,
  // then atomically rename it to its final `.json` name. Only that final name is observable here.
  const names = readdirSync(queueDirectory).filter((name) => name.endsWith(".json") && !reservedPaths.has(join(queueDirectory, name))).sort();
  const queued = new Map<string, { bytes: Buffer } | { error: unknown }>();
  for (const name of names) {
    const path = join(queueDirectory, name);
    try {
      if (!statSync(path).isFile()) throw new Error(`Queue entry is not a regular file: ${path}`);
      queued.set(path, { bytes: (input.readQueueFile ?? readFileSync)(path) });
    } catch (error) { queued.set(path, { error }); }
  }
  // Check before quarantine, admission writes, locks or snapshot capture. Recovery
  // above uses already-admitted retained bytes and never makes new admission choices.
  const admissionTree = inspectAdmissionTree(input, repoRoot, queueDirectory, queued, reservedPaths);
  if (!admissionTree.admissionClean && !admissionTree.allowDirtyAdmission) {
    throw new Error(`admission_tree_dirty: ${admissionTree.commitSha} has admission-relevant changes: ` +
      admissionTree.relevantChanges.map(({ path, status }) => `${path} [${status}]`).join(", ") +
      ". Commit or restore these paths, or explicitly use --allow-dirty-admission=true for a local run that is not schedule-equivalent.");
  }
  if (admissionTree.allowDirtyAdmission) console.error("admission_tree_opt_in: --allow-dirty-admission=true; this local run is not schedule-equivalent.");
  if (names.length === 0) throw new TransientAdmissionError(failures.join("\n") || "Intake queue has no pending candidate sidecars.");
  const registry = parseRoadmapProducerRegistry(readJson(join(repoRoot, "scripts", "github-issue-roadmap-producers.json"), "Producer registry"));
  const quarantinedEntries: IntakeDrainQuarantinedEntry[] = [...runDiagnostics];
  const parsed: { readonly queue: DrainQueueEntry; readonly envelope: OutcomeEnvelope }[] = [];
  for (const name of names) {
    const path = join(queueDirectory, name);
    try {
      const read = queued.get(path)!;
      if ("error" in read) throw read.error;
      const { bytes } = read;
      const corrected = correctedEnvelope(parseJsonBytes(bytes, path, "Queue sidecar"), registry);
      if (corrected.envelope.candidates.length === 0) throw new Error(`Queue entry ${path} has no pending candidates.`);
      const sourcePath = resolve(repoRoot, corrected.envelope.artifact.sourceLocator);
      // artifact.revisionSha256 is shape-validated only by design; hashing it here would widen this gate's measured blast radius.
      if (effectiveOutcomeCandidates(corrected.envelope, history).active.length > 0 && (!existsSync(sourcePath) || !statSync(sourcePath).isFile())) throw new Error(`Queue entry ${path} source file is missing: ${corrected.envelope.artifact.sourceLocator}`);
      /**
       * Passing evidence verification means only that these bytes match a hash the emitting agent
       * recorded. The author-supplied hash is unauthenticated: this does not prove the hash is
       * authentic, that the evidence supports the claim, or that the work described does not
       * already exist in the codebase.
       */
      const evidenceFailures: string[] = [];
      for (const candidate of effectiveOutcomeCandidates(corrected.envelope, history).active) {
        for (const evidence of candidate.evidence) {
          const evidencePath = resolve(repoRoot, evidence.sourceLocator);
          if (!pathIsWithin(repoRoot, evidencePath)) {
            evidenceFailures.push(`evidence ${evidence.id} escapes the repository: ${evidence.sourceLocator}`);
            continue;
          }
          if (!existsSync(evidencePath) || !statSync(evidencePath).isFile()) {
            evidenceFailures.push(`evidence ${evidence.id} file is missing: ${evidence.sourceLocator}`);
            continue;
          }
          const canonicalEvidencePath = realpathSync(evidencePath);
          if (!pathIsWithin(repoRoot, canonicalEvidencePath)) {
            evidenceFailures.push(`evidence ${evidence.id} escapes the repository: ${evidence.sourceLocator}`);
            continue;
          }
          if (!outcomeSourceContentMatchesSha256(readFileSync(canonicalEvidencePath), evidence.contentSha256)) {
            evidenceFailures.push(`evidence ${evidence.id} content has changed: ${evidence.sourceLocator}`);
          }
        }
      }
      if (evidenceFailures.length > 0) {
        throw new Error(`Queue entry ${path} has evidence verification failures:\n- ${evidenceFailures.join("\n- ")}`);
      }
      const queue: DrainQueueEntry = {
        path, contentSha256: sha256(bytes), sourceLocator: corrected.envelope.artifact.sourceLocator,
        declaredProducerKind: corrected.declared, producerKind: corrected.envelope.producer.kind,
        correction: corrected.correction, sourceFingerprints: corrected.envelope.candidates.map((candidate) => candidate.sourceFingerprint),
      };
      parsed.push({ queue, envelope: corrected.envelope });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      quarantinedEntries.push(quarantineQueueEntry(queueDirectory, path, reason));
    }
  }
  const mergeable: typeof parsed = [];
  for (const entry of parsed) {
    try {
      mergeEnvelopes([...mergeable, entry], history);
      mergeable.push(entry);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      quarantinedEntries.push(quarantineQueueEntry(queueDirectory, entry.queue.path, reason));
    }
  }
  if (mergeable.length === 0) throw new Error("Intake queue has no processable candidate sidecars after quarantine.");
  const stackBytes = readFileSync(stackPath);
  const stack = { path: admissionPath(repoRoot, stackPath), sha256: sha256(stackBytes), contentBase64: stackBytes.toString("base64") };
  const queueIdentity = canonicalJsonSha256({
    queue: mergeable.map(({ queue }) => ({ path: relative(repoRoot, queue.path).replace(/\\/g, "/"), sha256: queue.contentSha256 })),
    stack: { path: stack.path, sha256: stack.sha256 },
  });
  const runId = intakeDrainEnvelopeIdentity(queueIdentity, 1).runId;
  const runRoot = join(repoRoot, "artifacts", "github-issue-roadmap", "drains", runId);
  const manifestPath = join(runRoot, "manifest.json");
  const existingState = classifyRun(runRoot, target);
  if (existingState.status === "corrupt" && existsSync(runRoot)) throw new TerminalAdmissionError(`Corrupt intake run ${runId}, needs manual attention: ${existingState.reason}`);
  if (existingState.status === "abandoned") throw new TerminalAdmissionError(`Intake run ${runId} was abandoned; see roadmap:intake-holds list.`);
  if (existingState.status === "finished") {
    const existing = readJson(manifestPath, "Drain manifest") as IntakeDrainManifest;
    return publish(existing, quarantinedEntries);
  }
  const merged = mergeEnvelopes(mergeable, history);
  const repositories = new Set(merged.map(({ envelope }) => `${envelope.repository.databaseId}\0${envelope.repository.nodeId}`));
  if (repositories.size !== 1) throw new Error("One drain cannot share a snapshot across multiple repositories.");
  const admission: IntakeDrainAdmission = {
    schema: INTAKE_DRAIN_ADMISSION_SCHEMA, runId, queueIdentity, firstAttemptAt: new Date().toISOString(),
    preparedAt: (input.now ?? new Date()).toISOString(), queueDirectory: admissionPath(repoRoot, queueDirectory),
    admissionTree,
    queueEntries: mergeable.map(({ queue }) => ({ ...queue, path: admissionPath(repoRoot, queue.path) })),
    stack,
    envelopes: merged.map(({ envelope, queueEntries }) => ({
      envelope: { ...envelope, candidates: materialCandidates(envelope) },
      queueEntryIndexes: queueEntries.map((queue) => mergeable.findIndex((entry) => entry.queue === queue)),
    })),
    repository: merged[0].envelope.repository,
    quarantinedEntries: quarantinedEntries.filter((entry) => !runDiagnostics.includes(entry)).map((entry) => ({
      ...entry, originalPath: admissionPath(repoRoot, entry.originalPath),
      quarantinedPath: admissionPath(repoRoot, entry.quarantinedPath), reasonPath: admissionPath(repoRoot, entry.reasonPath),
    })),
  };
  if (`${admission.repository.organization}/${admission.repository.name}` !== target.repository) {
    throw new TerminalAdmissionError("Admission repository differs from configured target.");
  }
  writeOnce(join(runRoot, "admission.json"), prettyCanonicalJson(admission));
  const outcome = attemptAdmission(input, admission, () => { abandonmentCount += 1; }, abandonmentCount < MAX_ABANDONMENTS_PER_INVOCATION);
  if (outcome.manifest !== undefined) return publish(outcome.manifest);
  throw new TransientAdmissionError(outcome.failure ?? "Admission abandoned; see roadmap:intake-holds list.");
}

function admissionPath(repoRoot: string, path: string): string {
  if (resolve(repoRoot) !== resolve(path) && !pathIsWithin(repoRoot, path)) {
    throw new Error(`Admission path must remain inside the repository: ${path}`);
  }
  return relative(repoRoot, path).replace(/\\/g, "/") || ".";
}

/** Filesystem reads declare material absence as terminal, access/resource failures as
 * transient. This boundary never sees subprocess errors or walks an error's causes. */
function readAdmissionFile(path: string): Buffer {
  try { return readFileSync(path); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (["ENOENT", "EISDIR", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new TerminalAdmissionError(message, { cause: error });
    }
    throw new TransientAdmissionError(message, { cause: error });
  }
}

/** Unknown/wrapped external errors are retryable under the persisted bound. Adapters
 * may explicitly declare a deterministic terminal failure; no cause-chain guessing. */
function externalAdmissionStep<T>(step: () => T): T {
  try { return step(); }
  catch (error) {
    if (error instanceof TerminalAdmissionError || error instanceof TransientAdmissionError) throw error;
    throw new TransientAdmissionError(error instanceof Error ? error.message : String(error), { cause: error });
  }
}

/** Each invocation appends one marker. Names, not readable payloads, count attempts.
 * The drains root is the only marker home. Old in-run markers remain untouched;
 * ignoring that legacy history may add retries, never suppress admitted work. */
function attemptAdmission(input: PrepareIntakeDrainInput, admission: IntakeDrainAdmission, onAbandon: () => void, mayAbandon = true): {
  manifest?: IntakeDrainManifest; abandoned?: IntakeDrainQuarantinedEntry; failure?: string;
} {
  const repoRoot = resolve(input.repoRoot ?? process.cwd());
  const runRoot = join(repoRoot, "artifacts/github-issue-roadmap/drains", admission.runId);
  let reason: string | undefined;
  try {
    if (existsSync(runRoot)) {
      const markers: string[] = [];
      const prefix = `${admission.runId}-`;
      try {
        for (const name of readdirSync(dirname(runRoot))) {
          if (name.startsWith(prefix) && /^[a-f0-9-]{36}-attempts\.json$/.test(name.slice(prefix.length))) {
            markers.push(join(dirname(runRoot), name));
          }
        }
      } catch (error) {
        console.error(`Admission ${admission.runId}: attempt inventory unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      // Payloads provide timestamps for legacy admissions without firstAttemptAt.
      // Losing a timestamp does not lose the marker or refuse an attempt.
      let firstAttemptAt = admission.firstAttemptAt;
      for (const path of markers) {
        try {
          assertPathWithin(dirname(path), path);
          const marker = readJson(path, "Admission attempt") as { startedAt?: string };
          if (typeof marker.startedAt === "string" && Number.isFinite(Date.parse(marker.startedAt)) &&
              (firstAttemptAt === undefined || Date.parse(marker.startedAt) < Date.parse(firstAttemptAt))) firstAttemptAt = marker.startedAt;
        } catch (error) {
          console.error(`Admission ${admission.runId}: attempt detail unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (markers.length >= MAX_ADMISSION_ATTEMPTS ||
          (firstAttemptAt !== undefined && Date.now() - Date.parse(firstAttemptAt) >= MAX_ADMISSION_AGE_MS)) {
        reason = markers.length >= MAX_ADMISSION_ATTEMPTS
          ? `Admission retry bound reached (${MAX_ADMISSION_ATTEMPTS} attempts).`
          : `Admission retry age bound reached (${MAX_ADMISSION_AGE_MS} ms since first attempt).`;
      } else {
        const name = `${randomUUID()}-attempts.json`;
        const content = prettyCanonicalJson({ startedAt: new Date().toISOString() });
        try { atomicDrainWrite(join(dirname(runRoot), `${admission.runId}-${name}`), content); }
        catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          // Still attempt the work if the root rejects evidence; undercounting is repairable.
        }
        try {
          reconstructEnvelopes(repoRoot, admission);
          return { manifest: finishAdmission(input, admission) };
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error);
          if (!(error instanceof TerminalAdmissionError) && markers.length + 1 < MAX_ADMISSION_ATTEMPTS) {
            console.error(`Intake admission ${admission.runId} retry ${markers.length + 1}/${MAX_ADMISSION_ATTEMPTS}: ${reason}`);
            return { failure: reason };
          }
          if (!(error instanceof TerminalAdmissionError)) reason = `Admission retry bound reached (${MAX_ADMISSION_ATTEMPTS} attempts): ${reason}`;
        }
      }
    }
    if (!mayAbandon) return { failure: `Abandonment cap reached; ${admission.runId} remains visible for next invocation.` };
    onAbandon();
    const abandoned = quarantineAdmission(repoRoot, admission, reason);
    console.error(`Abandoned intake admission ${admission.runId}: ${abandoned.reason}; see roadmap:intake-holds list.`);
    return { abandoned };
  } catch (error) {
    const failure = `Intake admission ${admission.runId} needs recovery: ${error instanceof Error ? error.message : String(error)}`;
    console.error(failure);
    return { failure };
  }
}

function quarantineAdmission(repoRoot: string, admission: IntakeDrainAdmission, failure?: string): IntakeDrainQuarantinedEntry {
  const runRoot = join(repoRoot, "artifacts/github-issue-roadmap/drains", admission.runId);
  let quarantineRoot = `${runRoot}.quarantine`;
  // Preserve an existing quarantine rather than overwriting it or retrying the
  // same occupied destination forever, even if the original directory is gone.
  while (readdirSync(dirname(runRoot)).some((name) =>
    name === basename(quarantineRoot) || name.startsWith(`${basename(quarantineRoot)}.`))) {
    quarantineRoot = `${runRoot}.quarantine-${randomUUID()}`;
  }
  const originalPath = join(runRoot, "admission.json");
  let quarantinedPath = join(quarantineRoot, "admission.json");
  const reasonPath = `${quarantineRoot}.reason.txt`;
  // The root receipt commits abandonment before any best-effort housekeeping.
  // Its destination also identifies the evidence if relocation later succeeds.
  assertPathWithin(dirname(runRoot), runRoot);
  assertPathWithin(dirname(runRoot), quarantineRoot);
  const reason = failure ?? "Interrupted admission abandonment.";
  const sidecars: { originalPath: string; quarantinedPath: string }[] = [];
  const writeReceipt = () => atomicDrainWrite(`${quarantineRoot}.abandoned.json`, prettyCanonicalJson({
    runId: admission.runId, sidecars, reason,
    originalPath: admissionPath(repoRoot, originalPath),
    quarantinedPath: admissionPath(repoRoot, join(quarantineRoot, "admission.json")),
    reasonPath: admissionPath(repoRoot, reasonPath),
  }));
  writeReceipt();
  try { if (existsSync(runRoot)) renameSync(runRoot, quarantineRoot); }
  catch (error) {
    console.error(`Abandoned admission ${admission.runId} retained in place: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!existsSync(quarantineRoot)) quarantinedPath = originalPath;
  const result = { originalPath, quarantinedPath, reasonPath, reason };
  try {
    atomicDrainWrite(reasonPath, `${reason}\n`);
    for (const [index, entry] of admission.queueEntries.entries()) {
      const path = resolve(repoRoot, entry.path);
      const destination = `${quarantineRoot}.sidecar-${index}-${basename(path)}`;
      assertPathWithin(dirname(runRoot), destination);
      // Do not quarantine or remove a producer's replacement at the same path.
      if (existsSync(path)) {
        const bytes = readAdmissionFile(path);
        if (sha256(bytes) === entry.contentSha256) atomicDrainWrite(destination, bytes);
      }
      if (existsSync(destination) && sha256(readAdmissionFile(destination)) === entry.contentSha256) {
        sidecars.push({ originalPath: entry.path, quarantinedPath: admissionPath(repoRoot, destination) });
      }
    }
    writeReceipt();
    for (const entry of sidecars) {
      const path = resolve(repoRoot, entry.originalPath);
      if (existsSync(path) && sha256(readAdmissionFile(path)) === admission.queueEntries.find((queue) => queue.path === entry.originalPath)?.contentSha256) {
        try { unlinkSync(path); } catch { /* A leftover sidecar is safe to re-admit next invocation. */ }
      }
    }
  } catch (error) {
    // Leave queued bytes available for retry if any diagnostic/copy fails. The
    // root receipt already proves abandonment.
    console.error(`Abandonment diagnostics unavailable for ${admission.runId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
}

function reconstructEnvelopes(repoRoot: string, admission: IntakeDrainAdmission): void {
  const runRoot = join(repoRoot, "artifacts/github-issue-roadmap/drains", admission.runId);
  admission.envelopes.forEach(({ envelope }, index) => {
    const path = join(runRoot, `envelope-${index + 1}.json`);
    assertPathWithin(runRoot, path);
    writeOnce(path, outcomeEnvelopeJson(createOutcomeEnvelope(envelope)));
  });
}

function finishAdmission(input: PrepareIntakeDrainInput, admission: IntakeDrainAdmission): IntakeDrainManifest {
  const repoRoot = resolve(input.repoRoot ?? process.cwd());
  const { runId, queueIdentity } = admission;
  const runRoot = join(repoRoot, "artifacts", "github-issue-roadmap", "drains", runId);
  const manifestPath = join(runRoot, "manifest.json");
  for (const name of ["manifest.json", "assessment-stack.json", "canonical-snapshot.json", "intake-snapshot.json",
    ...admission.envelopes.flatMap((_, index) => [`envelope-${index + 1}.json`, `envelope-${index + 1}-intake-snapshot.json`,
      `envelope-${index + 1}-authored-request.json`, `exchange-${index + 1}`])]) assertPathWithin(runRoot, join(runRoot, name));
  const stackPath = join(runRoot, "assessment-stack.json");
  const queueDirectory = resolve(repoRoot, admission.queueDirectory);
  const queues = admission.queueEntries.map((entry) => ({ ...entry, path: resolve(repoRoot, entry.path) }));
  const merged = admission.envelopes.map(({ envelope, queueEntryIndexes }) => ({
    envelope: createOutcomeEnvelope(envelope), queueEntries: queueEntryIndexes.map((index) => queues[index]),
  }));
  // Recovery retains the admitted envelope unchanged, but reselects against current main.
  const history = (input.dispositionHistory ?? dispositionHistory)("origin/main", { repoRoot, runGit: input.runGit });
  const skipped = merged.flatMap(({ envelope }) => intakeDispositionSkips(envelope, history));
  const activeIndexes = merged.flatMap(({ envelope }, index) => effectiveOutcomeCandidates(envelope, history).active.length > 0 ? [index] : []);
  const quarantinedEntries = admission.quarantinedEntries.map((entry) => ({
    ...entry, originalPath: resolve(repoRoot, entry.originalPath), quarantinedPath: resolve(repoRoot, entry.quarantinedPath),
    reasonPath: resolve(repoRoot, entry.reasonPath),
  }));
  const sidecarDivergences = queues.flatMap((entry) => {
    if (!existsSync(entry.path)) return [];
    const currentSha256 = sha256(readAdmissionFile(entry.path));
    if (currentSha256 === entry.contentSha256) return [];
    console.error(`Admission ${runId}: replacement sidecar differs at ${entry.path}; resuming retained material.`);
    return [{ path: entry.path, admittedSha256: entry.contentSha256, currentSha256 }];
  });
  const canonicalPath = join(runRoot, "canonical-snapshot.json");
  const sharedIntakePath = join(runRoot, "intake-snapshot.json");
  const envelopePaths = merged.map((_, index) => join(runRoot, `envelope-${index + 1}.json`));
  {
    // Keep envelope reconstruction first: an admission alone still reconstructs all material
    // before touching downstream artifacts, as the decisive CLI interruption test proves.
    const content = admission.stack.contentBase64;
    const bytes = content === undefined ? readAdmissionFile(resolve(repoRoot, admission.stack.path)) : Buffer.from(content, "base64");
    if ((content !== undefined && bytes.toString("base64") !== content) || sha256(bytes) !== admission.stack.sha256) {
      throw new TerminalAdmissionError("Admitted assessment stack content disagrees with its retained hash.");
    }
    writeOnce(stackPath, bytes);
  }
  const repository = input.repository ?? DEFAULT_INTAKE_REPOSITORY;
  const dependencies = input.dependencies ?? defaultDependencies(undefined, input.dispositionHistory);
  if (activeIndexes.length > 0 && !existsSync(sharedIntakePath)) {
    const stagingRoot = join(runRoot, `.snapshot-${randomUUID()}`);
    mkdirSync(stagingRoot);
    const stagedCanonical = join(stagingRoot, "canonical.json");
    const stagedIntake = join(stagingRoot, "intake.json");
    externalAdmissionStep(() => dependencies.captureSnapshots({ repoRoot, candidatePath: envelopePaths[activeIndexes[0]], canonicalPath: stagedCanonical, intakePath: stagedIntake, repository }));
    // A failed capture can only tear staging files. Publish intake last as the pair's checkpoint.
    readJson(stagedCanonical, "Captured canonical snapshot");
    retainedSnapshot(stagedIntake);
    atomicDrainWrite(canonicalPath, readAdmissionFile(stagedCanonical));
    atomicDrainWrite(sharedIntakePath, readAdmissionFile(stagedIntake));
  }
  const envelopes: IntakeDrainEnvelope[] = activeIndexes.map(index => {
    const { envelope, queueEntries } = merged[index];
    const intakeSnapshotPath = join(runRoot, `envelope-${index + 1}-intake-snapshot.json`);
    rebindSnapshot(sharedIntakePath, envelope, intakeSnapshotPath);
    const exchangeRoot = join(runRoot, `exchange-${index + 1}`);
    const authoredPath = join(runRoot, `envelope-${index + 1}-authored-request.json`);
    const { runDiscriminator } = intakeDrainEnvelopeIdentity(queueIdentity, index + 1);
    const authored = reusableAuthoredRequest(exchangeRoot, authoredPath) ?? externalAdmissionStep(() => dependencies.authorRequest({
      repoRoot, candidatePath: envelopePaths[index], intakeSnapshotPath, stackPath, exchangeRoot,
      runDiscriminator,
    }));
    assertAuthoredRequestPaths(exchangeRoot, authored, "Authored request");
    checkpointAuthoredRequest(authoredPath, authored);
    return {
      index: index + 1, candidatePath: envelopePaths[index], intakeSnapshotPath, exchangeRoot,
      bundlePath: authored.bundlePath, assessmentTarget: authored.assessmentTarget,
      decisionPath: join(runRoot, `decision-${index + 1}.json`), queueEntries,
    };
  });
  const manifest: IntakeDrainManifest = {
    schemaVersion: INTAKE_DRAIN_MANIFEST_SCHEMA, runId,
    preparedAt: admission.preparedAt, queueDirectory,
    ...(admission.admissionTree === undefined ? {} : { admissionTree: admission.admissionTree }),
    stackPath, snapshots: { canonical: canonicalPath, intake: sharedIntakePath },
    approvalPlanPath: join(runRoot, "approval-plan.json"), processedDirectory: join(queueDirectory, "processed", runId),
    quarantinedEntries, sidecarDivergences, envelopes, ...(skipped.length > 0 ? { skipped,
      skippedEnvelopes: merged.flatMap(({ queueEntries }, index) => activeIndexes.includes(index) ? [] : [{ candidatePath: envelopePaths[index], queueEntries }]),
    } : {}),
  };
  writeOnce(manifestPath, prettyCanonicalJson(manifest));
  return manifest;
}

function assertReportCoverage(manifest: IntakeDrainManifest, decisions: readonly unknown[]): void {
  const expected = new Map<string, number>();
  for (const envelope of [...manifest.envelopes, ...manifest.skippedEnvelopes ?? []]) {
    for (const queue of envelope.queueEntries) {
      for (const fingerprint of queue.sourceFingerprints) expected.set(fingerprint, 0);
    }
  }
  for (const decision of decisions) {
    const report = decision as { candidates?: readonly { sourceFingerprint?: string }[]; skipped?: readonly IntakeDispositionSkip[] };
    for (const candidate of [...report.candidates ?? [], ...report.skipped ?? []]) {
      if (typeof candidate.sourceFingerprint === "string" && expected.has(candidate.sourceFingerprint)) {
        expected.set(candidate.sourceFingerprint, expected.get(candidate.sourceFingerprint)! + 1);
      }
    }
  }
  for (const candidate of manifest.skipped ?? []) {
    if (expected.get(candidate.sourceFingerprint) === 0) expected.set(candidate.sourceFingerprint, 1);
  }
  const unaccounted = [...expected.entries()].filter(([, count]) => count !== 1);
  if (unaccounted.length > 0) {
    const details = unaccounted.map(([fingerprint, count]) => `${fingerprint} (${count} report candidates)`).join(", ");
    throw new Error(`Drain decision reports do not account for every queued fingerprint exactly once: ${details}`);
  }
}

function moveProcessed(manifest: IntakeDrainManifest, decisions: readonly unknown[]): void {
  mkdirSync(manifest.processedDirectory, { recursive: true });
  const dispositions = new Map<string, {
    readonly queue: DrainQueueEntry;
    readonly presentations: Map<string, IntakeApprovalEntry["presentation"] | "dispositioned">;
  }>();
  [...manifest.envelopes, ...manifest.skippedEnvelopes ?? []].forEach((envelope, index) => {
    const report = decisions[index] as { candidates?: readonly { sourceFingerprint?: string; presentation?: string }[]; skipped?: readonly IntakeDispositionSkip[] } | undefined;
    for (const queue of envelope.queueEntries) {
      const current = dispositions.get(queue.path) ?? { queue, presentations: new Map() };
      for (const candidate of report?.candidates ?? []) {
        if (typeof candidate.sourceFingerprint === "string" && queue.sourceFingerprints.includes(candidate.sourceFingerprint)) {
          current.presentations.set(candidate.sourceFingerprint, candidate.presentation as IntakeApprovalEntry["presentation"]);
        }
      }
      for (const candidate of report?.skipped ?? manifest.skipped ?? []) {
        if (queue.sourceFingerprints.includes(candidate.sourceFingerprint)) current.presentations.set(candidate.sourceFingerprint, "dispositioned");
      }
      dispositions.set(queue.path, current);
    }
  });
  for (const { queue, presentations } of dispositions.values()) {
    const candidateDispositions = queue.sourceFingerprints.map((sourceFingerprint) => ({
      sourceFingerprint,
      presentation: presentations.get(sourceFingerprint)!,
    }));
    const drafted = candidateDispositions.filter(({ presentation }) => presentation === "draft").length;
    const outcome = candidateDispositions.every(candidate => candidate.presentation === "dispositioned") ? "dispositioned" : drafted === candidateDispositions.length && drafted > 0
      ? "drafted"
      : drafted === 0 ? "held" : "mixed";
    const destination = join(manifest.processedDirectory, `${outcome}--${basename(queue.path)}`);
    const possibleDestinations = ["drafted", "held", "mixed", "dispositioned"].map((prefix) =>
      join(manifest.processedDirectory, `${prefix}--${basename(queue.path)}`));
    const dispositionPath = `${destination}.dispositions.json`;
    const dispositionContent = `${JSON.stringify({ candidates: candidateDispositions }, null, 2)}\n`;
    if (existsSync(queue.path)) {
      if (possibleDestinations.some((path) => existsSync(path))) throw new Error(`Processed destination already exists for ${queue.path}.`);
      renameSync(queue.path, destination);
    } else if (!existsSync(destination)) {
      const previous = possibleDestinations.find(path => existsSync(path));
      if (previous === undefined) throw new Error(`Pending queue entry disappeared before collection: ${queue.path}`);
      const prior = readJson(`${previous}.dispositions.json`, "Prior processed dispositions") as { candidates: typeof candidateDispositions };
      if (prior.candidates.length !== candidateDispositions.length || candidateDispositions.some(candidate =>
        !prior.candidates.some(old => old.sourceFingerprint === candidate.sourceFingerprint &&
          (old.presentation === candidate.presentation || candidate.presentation === "dispositioned")))) {
        throw new Error("Processed candidate accounting may only change to dispositioned.");
      }
      renameSync(previous, destination);
    }
    writeOnce(dispositionPath, dispositionContent);
  }
}

function moveProcessedWithLock(manifest: IntakeDrainManifest, decisions: readonly unknown[]): void {
  const lockPath = join(manifest.queueDirectory, COLLECT_LOCK_NAME);
  const token = `${JSON.stringify({ pid: process.pid, runId: manifest.runId, acquiredAt: new Date().toISOString() })}\n`;
  for (;;) {
    try {
      const claimDirectory = `${lockPath}.tmp-${randomUUID()}`;
      mkdirSync(claimDirectory);
      try {
        atomicDrainWrite(join(claimDirectory, "owner.json"), token);
        // Renaming a nonempty directory never replaces another nonempty lock directory.
        // Legacy file locks also refuse replacement and retain stale recovery below.
        if (existsSync(lockPath)) throw Object.assign(new Error("Collect lock already exists"), { code: "EEXIST" });
        renameSync(claimDirectory, lockPath);
      } finally {
        if (existsSync(claimDirectory)) {
          try { unlinkSync(join(claimDirectory, "owner.json")); rmdirSync(claimDirectory); } catch { /* unpublished claim */ }
        }
      }
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["EEXIST", "ENOTEMPTY", "EPERM", "EISDIR", "ENOTDIR"].includes(code ?? "") || !existsSync(lockPath)) throw error;
      let age: number;
      try { age = Date.now() - statSync(lockPath).mtimeMs; }
      catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (age <= COLLECT_LOCK_STALE_MS) {
        throw new Error(`Intake drain collect is already moving queue entries: ${lockPath}`);
      }
      const stalePath = `${lockPath}.stale-${randomUUID()}`;
      try {
        renameSync(lockPath, stalePath);
        if (statSync(stalePath).isDirectory()) { unlinkSync(join(stalePath, "owner.json")); rmdirSync(stalePath); }
        else unlinkSync(stalePath);
      } catch (recoveryError) {
        if ((recoveryError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error(`Stale intake drain collect lock could not be recovered: ${lockPath}`, { cause: recoveryError });
      }
    }
  }
  try {
    moveProcessed(manifest, decisions);
  } finally {
    try {
      if (readFileSync(join(lockPath, "owner.json"), "utf8") === token) { unlinkSync(join(lockPath, "owner.json")); rmdirSync(lockPath); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function collectIntakeDrain(input: {
  readonly manifestPath: string; readonly repoRoot?: string; readonly dependencies?: IntakeDrainDependencies;
  readonly dispositionHistory?: typeof dispositionHistory;
}): IntakeApprovalPlan {
  const repoRoot = resolve(input.repoRoot ?? process.cwd());
  const manifest = readJson(resolve(repoRoot, input.manifestPath), "Drain manifest") as IntakeDrainManifest;
  if (manifest.schemaVersion !== INTAKE_DRAIN_MANIFEST_SCHEMA) throw new Error("Unsupported drain manifest schema.");
  const history = (input.dispositionHistory ?? dispositionHistory)("origin/main", { repoRoot });
  if (manifest.envelopes.length === 0 && (manifest.skipped?.length ?? 0) > 0) {
    const decision = { path: resolve(repoRoot, input.manifestPath), contentSha256: sha256(readAdmissionFile(resolve(repoRoot, input.manifestPath))) };
    const plan: IntakeApprovalPlan = { schemaVersion: "github-issue-roadmap-intake-approval-plan/v1", generatedAt: manifest.preparedAt,
      decision, decisions: [], entries: [], skipped: manifest.skipped!.map(candidate => ({ ...candidate, decisionReport: decision, approvable: false, approved: false })) };
    writeOnce(manifest.approvalPlanPath, prettyCanonicalJson(plan));
    assertReportCoverage(manifest, []);
    moveProcessedWithLock(manifest, []);
    return plan;
  }
  const dependencies = input.dependencies ?? defaultDependencies(undefined, input.dispositionHistory);
  const runRoot = dirname(manifest.approvalPlanPath);
  const supersededBindings = new Map<string, readonly string[]>();
  const reports = manifest.envelopes.map((envelope) => {
    if (!existsSync(envelope.decisionPath)) {
      const existencePath = join(runRoot, `existence-${envelope.index}.json`);
      assertPathWithin(runRoot, existencePath);
      dependencies.runShadow({
        repoRoot, candidatePath: envelope.candidatePath, intakeSnapshotPath: envelope.intakeSnapshotPath,
        assessmentPath: envelope.assessmentTarget, decisionPath: envelope.decisionPath, existencePath,
        dispositionHistory: input.dispositionHistory,
      });
    }
    const report = readJson(envelope.decisionPath, "Drain decision report") as IntakeShadowReport;
    if (report.previousDecisionSha256s !== undefined) supersededBindings.set(resolve(envelope.decisionPath), report.previousDecisionSha256s);
    const candidate = parseOutcomeEnvelope(readJson(envelope.candidatePath, "Retained candidate"));
    const active = new Set(effectiveOutcomeCandidates(candidate, history).active.map(candidate => candidate.sourceFingerprint));
    if (!report.candidates.some(candidate => !active.has(candidate.sourceFingerprint))) return report;
    // Repeated collect is consumption too. Retain the input bytes and retire newly terminal
    // entries from an older report; the replacement approval plan starts unapproved.
    const rawAssessment = readJson(envelope.assessmentTarget, "Retained assessment");
    const snapshot = retainedSnapshot(envelope.intakeSnapshotPath);
    const assessment = parseIntakeAssessment(rawAssessment, candidate, snapshot, undefined, history);
    const skipped = intakeDispositionSkips(candidate, history);
    const decision = report.decision.verifiedOriginMainSha === undefined ? {
      ...report.decision, candidates: report.decision.candidates.filter(candidate => active.has(candidate.sourceFingerprint)),
      assessmentSha256: intakeAssessmentSha256(assessment), skipped,
    } : compileIntakeDecision({ envelope: candidate, snapshot, assessment, dispositionHistory: history,
      existenceRecord: readJson(join(runRoot, `existence-${envelope.index}.json`), "Retained existence record"),
      verifiedOriginMainSha: report.decision.verifiedOriginMainSha, generatedAt: report.decision.generatedAt,
    });
    const previousDecisionSha256s = [...report.previousDecisionSha256s ?? [], sha256(readAdmissionFile(envelope.decisionPath))];
    const updated = { ...report, decision, candidates: report.candidates.filter(candidate => active.has(candidate.sourceFingerprint)),
      skipped, assessmentInputSha256: canonicalJsonSha256(rawAssessment), previousDecisionSha256s };
    supersededBindings.set(resolve(envelope.decisionPath), previousDecisionSha256s);
    atomicDrainWrite(envelope.decisionPath, prettyCanonicalJson(updated));
    return updated;
  });
  assertReportCoverage(manifest, reports);
  let plan: IntakeApprovalPlan | null = null;
  let rebuildPlan = false;
  if (existsSync(manifest.approvalPlanPath)) {
    plan = readJson(manifest.approvalPlanPath, "Drain approval plan") as IntakeApprovalPlan;
    const current = new Map(manifest.envelopes.map((envelope) => [resolve(envelope.decisionPath), sha256(readFileSync(envelope.decisionPath))]));
    if (plan.decisions.length !== current.size || plan.decisions.some((binding) => current.get(resolve(binding.path)) !== binding.contentSha256 &&
        !supersededBindings.get(resolve(binding.path))?.includes(binding.contentSha256))) {
      throw new Error("Existing drain approval plan is stale against its decision reports.");
    }
    rebuildPlan = plan.decisions.some(binding => current.get(resolve(binding.path)) !== binding.contentSha256);
  }
  if (plan === null || rebuildPlan) {
    plan = buildMergedIntakeApprovalPlan({
      decisions: manifest.envelopes.map((envelope) => ({ path: envelope.decisionPath, content: readFileSync(envelope.decisionPath, "utf8") })),
      now: new Date(manifest.preparedAt),
    });
    const decisionBinding = plan.decision;
    const accounted = new Set((plan.skipped ?? []).map(candidate => candidate.sourceFingerprint));
    plan = { ...plan, ...(manifest.skipped === undefined ? {} : { skipped: [...plan.skipped ?? [],
      ...manifest.skipped.filter(candidate => !accounted.has(candidate.sourceFingerprint)).map(candidate => ({ ...candidate,
        decisionReport: decisionBinding, approvable: false as const, approved: false as const })),
    ] }) };
    if (rebuildPlan) atomicDrainWrite(manifest.approvalPlanPath, `${JSON.stringify(plan, null, 2)}\n`);
    else writeOnce(manifest.approvalPlanPath, `${JSON.stringify(plan, null, 2)}\n`);
  }
  const runEvidencePath = join(runRoot, "run-evidence.json");
  const writtenAssessments: string[] = [];
  let evidenceWritten = false;
  try {
    const readSibling = (path: string) => {
      assertPathWithin(runRoot, path);
      if (dirname(resolve(path)) !== resolve(runRoot)) throw new Error(`Evidence must be a run-root sibling: ${path}`);
      return { path: basename(path), bytes: readFileSync(path) };
    };
    const admission = readJson(join(runRoot, "admission.json"), "Drain admission") as IntakeDrainAdmission;
    if (admission.runId !== manifest.runId || admission.preparedAt !== manifest.preparedAt) throw new Error("run_id");
    const repository = `${admission.repository.organization}/${admission.repository.name}`;
    const built = buildRunEvidence({
      runId: admission.runId, repository, preparedAt: admission.preparedAt,
      approvalPlan: readSibling(manifest.approvalPlanPath), census: readSibling(manifest.snapshots.intake),
      decisions: manifest.envelopes.map((envelope) => {
        // Exchange assessments have the same basename. Retain uniquely named run-root copies.
        const assessmentPath = join(runRoot, `assessment-${envelope.index}.json`);
        assertPathWithin(runRoot, assessmentPath);
        assertPathWithin(runRoot, envelope.assessmentTarget);
        const alreadyPresent = existsSync(assessmentPath);
        writeOnce(assessmentPath, readFileSync(envelope.assessmentTarget));
        if (!alreadyPresent) writtenAssessments.push(assessmentPath);
        return { decision: readSibling(envelope.decisionPath), candidate: readSibling(envelope.candidatePath),
          snapshot: readSibling(envelope.intakeSnapshotPath), assessment: readSibling(assessmentPath) };
      }),
    });
    if (!built.ok) throw new Error(built.reason);
    assertPathWithin(runRoot, runEvidencePath);
    // A repeated collect can bind the operator's newly approved plan. All retained
    // assessment inputs still have to verify before this evidence is republished.
    atomicDrainWrite(runEvidencePath, prettyCanonicalJson(built.evidence));
    evidenceWritten = true;
    const verified = verifyRunEvidence({ evidenceBytes: readFileSync(runEvidencePath), plan, repository, runId: manifest.runId,
      files: (name) => readSibling(join(runRoot, name)).bytes });
    if (!verified.ok) throw new Error(`${verified.reason}: ${verified.detail}`);
    atomicDrainWrite(resolve(repoRoot, input.manifestPath), prettyCanonicalJson({
      ...manifest, runEvidencePath, runEvidenceSha256: verified.artifactSha256,
    }));
  } catch (error) {
    const cleanupErrors: string[] = [];
    for (const path of [...(evidenceWritten ? [runEvidencePath] : []), ...writtenAssessments]) {
      try { unlinkSync(path); }
      catch (cleanupError) {
        const code = (cleanupError as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") cleanupErrors.push(`${basename(path)} (${code ?? "unknown"})`);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new Error(`run_evidence_unavailable: ${error instanceof Error ? error.message : String(error)}; cleanup failed: ${cleanupErrors.join(", ")}`, { cause: error });
    }
    throw new Error(`run_evidence_unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  moveProcessedWithLock(manifest, reports);
  return plan;
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

export function runCli(argv: readonly string[], readHistory = dispositionHistory): void {
  const [phase, ...rest] = argv;
  const values = argumentsMap(rest);
  if (phase === "prepare") {
    const stackPath = values.get("stack");
    if (stackPath === undefined) throw new Error("Drain prepare requires --stack=PATH.");
    const allowDirty = values.get("allow-dirty-admission");
    if (allowDirty !== undefined && allowDirty !== "true" && allowDirty !== "false") {
      throw new Error("Drain prepare requires --allow-dirty-admission=true or false.");
    }
    const manifest = prepareIntakeDrain({ stackPath, queueDirectory: values.get("queue"), allowDirtyAdmission: allowDirty === "true", dispositionHistory: readHistory });
    console.log(join(dirname(manifest.approvalPlanPath), "manifest.json"));
    const repoRoot = process.cwd();
    const inventory = readIntakeRuns(join(repoRoot, "artifacts/github-issue-roadmap/drains"), {
      repoRoot, queueDirectory: resolve(repoRoot, values.get("queue") ?? DEFAULT_INTAKE_QUEUE),
      stackPath: resolve(repoRoot, stackPath), repository: DEFAULT_INTAKE_REPOSITORY,
    });
    if (inventory.status !== "available" || inventory.runs.some((run) => run.status === "unfinished" || run.status === "corrupt")) {
      process.exitCode = 1;
    }
  } else if (phase === "collect") {
    const manifestPath = values.get("manifest");
    if (manifestPath === undefined) throw new Error("Drain collect requires --manifest=PATH.");
    console.log(collectIntakeDrain({ manifestPath, dispositionHistory: readHistory }).entries.length);
  } else throw new Error("Drain requires phase prepare or collect.");
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  try { runCli(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
