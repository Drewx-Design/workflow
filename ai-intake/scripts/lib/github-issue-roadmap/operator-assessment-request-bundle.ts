import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { canonicalJsonSha256, prettyCanonicalJson } from "./canonical-json";
import {
  assessmentStackSha256,
  intakeSnapshotCoverageSha256,
  parseAssessmentStackDescriptor,
  type AssessmentStackIdentity,
} from "./intake-assessment";
import { parseIntakeSnapshotV1 } from "./intake-snapshot";
import { parseOutcomeEnvelope } from "./outcome-candidate";
import { effectiveOutcomeCandidates, type DispositionHistoryLookup } from "./disposition-selection";
import { intakeDispositionSkips } from "./intake-assessment";

const HANDOFF_SCHEMA = "github-issue-roadmap-shadow-assessment-handoff/v1" as const;
const REQUEST_SCHEMA = "github-issue-roadmap-shadow-assessment-request/v1" as const;
const SESSION_SCHEMA = "github-issue-roadmap-shadow-evaluation-session/v1" as const;
const OPERATOR_HANDOFF_SCHEMA = "github-issue-roadmap-operator-assessment-handoff/v1" as const;
const SAFE_RUN_ID = /^(?=.{1,128}$)(?=.*[^.])[A-Za-z0-9._-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const MAX_HANDOFF_FILE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_OPERATOR_ASSESSMENT_DEADLINE_MS = 20 * 60 * 1000;
const DEFAULT_ASSESSMENT_PROMPT_LOCATOR = "scripts/github-issue-roadmap-assessment-prompt.md";
const DEFAULT_ASSESSMENT_STACK_LOCATOR = "scripts/github-issue-roadmap-assessment-stack.json";
const DEFAULT_ASSESSMENT_SCHEMA_LOCATOR = "scripts/github-issue-roadmap-assessment-schema.json";

export const OPERATOR_ASSESSMENT_REQUEST_FILES = [
  { role: "assessment_request", name: "assessment-request.json" },
  { role: "candidate_envelope", name: "candidate-envelope.json" },
  { role: "intake_snapshot", name: "intake-snapshot.json" },
  { role: "assessment_prompt", name: "assessment-prompt.md" },
  { role: "assessment_stack", name: "assessment-stack.json" },
  { role: "assessment_schema", name: "assessment-schema.json" },
] as const;

export type OperatorAssessmentRequestRole = (typeof OPERATOR_ASSESSMENT_REQUEST_FILES)[number]["role"];

export interface OperatorAssessmentRequestSource {
  readonly role: OperatorAssessmentRequestRole;
  readonly locator: string;
}

export interface OperatorAssessmentRequestManifest {
  readonly schemaVersion: typeof HANDOFF_SCHEMA;
  readonly state: "awaiting_evaluator";
  readonly runId: string;
  readonly requestSequence: number;
  readonly requestSha256: string;
  readonly continuationNonce: string;
  readonly emittedAt: string;
  readonly expiresAt: string;
  readonly files: readonly {
    readonly role: OperatorAssessmentRequestRole;
    readonly path: string;
    readonly contentSha256: string;
    readonly byteLength: number;
  }[];
  readonly manifestSha256: string;
}

export interface OperatorAssessmentHandoff {
  readonly schemaVersion: typeof OPERATOR_HANDOFF_SCHEMA;
  readonly runId: string;
  readonly exchangeRoot: string;
  readonly bundlePath: string;
  readonly assessmentTarget: string;
  readonly files: Readonly<Record<OperatorAssessmentRequestRole, string>>;
}

export interface AuthoredOperatorAssessmentRequestBundle {
  readonly runId: string;
  readonly requestLocator: string;
  readonly bundlePath: string;
  readonly operatorHandoffPath: string;
  readonly handoff: OperatorAssessmentHandoff;
  readonly manifest: OperatorAssessmentRequestManifest;
}

type JsonRecord = Record<string, unknown>;

function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function record(value: unknown, context: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
  return value as JsonRecord;
}

function nonEmpty(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${context} must be non-empty.`);
  return value;
}

function sha256(value: unknown, context: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${context} must be a lowercase SHA-256.`);
  return value;
}

function timestamp(value: string, context: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${context} must be a canonical ISO timestamp.`);
  }
  return value;
}

function assertNonLinkDirectory(path: string, context: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${context} must be a non-link directory.`);
  }
}

function readRegular(path: string, context: string): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_HANDOFF_FILE_BYTES) {
    throw new Error(`${context} must be a bounded non-link regular file.`);
  }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const bytes = readFileSync(descriptor);
    const after = lstatSync(path);
    if (after.isSymbolicLink() || before.ino !== after.ino || after.size !== bytes.byteLength) {
      throw new Error(`${context} changed identity while it was read.`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function repoFile(repoRoot: string, locator: string, context: string): string {
  if (locator.includes("\\") || isAbsolute(locator) || locator.split("/").some((part) =>
    part === "" || part === "." || part === ".." || part.includes(":"))) {
    throw new Error(`${context} locator is not a safe repository-relative path.`);
  }
  const root = resolve(repoRoot);
  assertNonLinkDirectory(root, "Operator assessment repository root");
  const path = resolve(root, locator);
  const fromRoot = relative(root, path);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error(`${context} locator escaped the repository.`);
  }
  let current = root;
  for (const part of locator.split("/")) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`${context} locator traverses a symbolic link.`);
  }
  return path;
}

function assertNoSecretLikeContent(bytes: Uint8Array, context: string): void {
  const text = Buffer.from(bytes).toString("utf8");
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9]{24,})\b/,
    /\b(?:GH_READ_ONLY_TOKEN|GH_TOKEN|GITHUB_TOKEN|ROADMAP_SHADOW_PUBLISH_TOKEN|DATABASE_URL|OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*[=:]\s*["']?[^\s,"'}]{8,}/i,
  ];
  if (patterns.some((pattern) => pattern.test(text))) throw new Error(`${context} contains secret-like content.`);
}

function writeAll(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const count = writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error("Operator assessment bundle write made no progress.");
    offset += count;
  }
}

function writeExclusive(path: string, bytes: Buffer): void {
  const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY |
    (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeAll(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeOnce(path: string, bytes: Buffer, context: string): void {
  if (existsSync(path)) {
    if (!readRegular(path, context).equals(bytes)) throw new Error(`${context} already exists with different bytes.`);
    return;
  }
  writeExclusive(path, bytes);
}

function ensureDirectory(path: string, context: string, createParents = false): void {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700, recursive: createParents });
  assertNonLinkDirectory(path, context);
}

function ensureRepoArtifactRoot(repoRoot: string, runId: string): string {
  const root = resolve(repoRoot);
  assertNonLinkDirectory(root, "Operator assessment repository root");
  let current = root;
  for (const part of ["artifacts", "github-issue-roadmap", "operator-assessment-requests", runId]) {
    current = join(current, part);
    ensureDirectory(current, `Operator assessment artifact directory ${part}`);
  }
  return current;
}

function runIdFor(clock: Date, discriminator?: string): string {
  if (!Number.isFinite(clock.getTime())) throw new Error("Operator assessment clock must be valid.");
  const runId = discriminator === undefined
    ? `operator-${clock.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`
    : `operator-${discriminator}`;
  if (!SAFE_RUN_ID.test(runId)) throw new Error("Operator assessment run discriminator must produce a safe run ID.");
  return runId;
}

function locatorFromRepo(repoRoot: string, path: string): string {
  return relative(resolve(repoRoot), path).split("\\").join("/");
}

function sameResolvedPath(left: string, right: string): boolean {
  return relative(resolve(left), resolve(right)) === "";
}

function stackIdentity(descriptor: ReturnType<typeof parseAssessmentStackDescriptor>): AssessmentStackIdentity {
  return {
    provider: descriptor.provider,
    model: descriptor.model,
    promptSha256: descriptor.promptSha256,
    rubricSha256: descriptor.rubricSha256,
    toolchainSha256: descriptor.toolchainSha256,
    calibrationRelease: descriptor.calibrationRelease,
  };
}

function startOperatorEvaluationSession(input: {
  readonly exchangeRoot: string;
  readonly scheduledExchangeRoot: string;
  readonly runId: string;
  readonly trustedMainSha: string;
  readonly startedAt: string;
  readonly deadlineAt: string;
}): string {
  if (sameResolvedPath(input.exchangeRoot, input.scheduledExchangeRoot)) {
    throw new Error("Operator assessment exchange root must not equal the scheduled roadmap shadow exchange root.");
  }
  if (!GIT_SHA.test(input.trustedMainSha)) throw new Error("Operator assessment trusted main must be a Git SHA.");
  const exchangeRoot = resolve(input.exchangeRoot);
  ensureDirectory(exchangeRoot, "Operator assessment exchange root", true);
  const sessionsRoot = join(exchangeRoot, "sessions");
  ensureDirectory(sessionsRoot, "Operator assessment sessions root");
  const existingNames = readdirSync(sessionsRoot);
  if (existingNames.some((name) => name !== input.runId)) {
    throw new Error("Operator assessment exchange root must be dedicated to exactly one run.");
  }
  const runRoot = join(sessionsRoot, input.runId);
  ensureDirectory(runRoot, "Operator assessment session root");
  if (existsSync(join(runRoot, "session-complete.json"))) {
    throw new Error("Completed operator assessment session cannot be restarted.");
  }
  const body = {
    schemaVersion: SESSION_SCHEMA,
    runId: input.runId,
    trustedMainSha: input.trustedMainSha,
    startedAt: input.startedAt,
    deadlineAt: input.deadlineAt,
  } as const;
  const session = { ...body, sessionSha256: canonicalJsonSha256(body) };
  writeOnce(
    join(runRoot, "session-start.json"),
    Buffer.from(prettyCanonicalJson(session), "utf8"),
    "Operator assessment session start",
  );
  return runRoot;
}

function requestLocator(request: JsonRecord, role: OperatorAssessmentRequestRole): string | undefined {
  if (role === "candidate_envelope") return nonEmpty(record(request.archivedCandidate, "archivedCandidate").locator, "archivedCandidate.locator");
  if (role === "intake_snapshot") return nonEmpty(record(request.intakeSnapshot, "intakeSnapshot").locator, "intakeSnapshot.locator");
  if (role === "assessment_prompt") return nonEmpty(record(request.prompt, "prompt").locator, "prompt.locator");
  if (role === "assessment_stack") return nonEmpty(record(request.stackDescriptor, "stackDescriptor").locator, "stackDescriptor.locator");
  if (role === "assessment_schema") return nonEmpty(record(request.assessmentSchema, "assessmentSchema").locator, "assessmentSchema.locator");
  return undefined;
}

function requestContentSha256(request: JsonRecord, role: OperatorAssessmentRequestRole): string | undefined {
  if (role === "candidate_envelope") return sha256(record(request.archivedCandidate, "archivedCandidate").contentSha256, "archivedCandidate.contentSha256");
  if (role === "intake_snapshot") return sha256(record(request.intakeSnapshot, "intakeSnapshot").fileSha256, "intakeSnapshot.fileSha256");
  if (role === "assessment_prompt") return sha256(record(request.prompt, "prompt").contentSha256, "prompt.contentSha256");
  if (role === "assessment_stack") return sha256(record(request.stackDescriptor, "stackDescriptor").contentSha256, "stackDescriptor.contentSha256");
  if (role === "assessment_schema") return sha256(record(request.assessmentSchema, "assessmentSchema").contentSha256, "assessmentSchema.contentSha256");
  return undefined;
}

function sourceLocators(sources: readonly OperatorAssessmentRequestSource[]): Map<OperatorAssessmentRequestRole, string> {
  const byRole = new Map<OperatorAssessmentRequestRole, string>();
  const allowed = new Set<string>(OPERATOR_ASSESSMENT_REQUEST_FILES.map(({ role }) => role));
  for (const source of sources) {
    if (!allowed.has(source.role)) throw new Error(`Operator assessment bundle role ${String(source.role)} is not allowed.`);
    if (byRole.has(source.role)) throw new Error(`Operator assessment bundle role ${source.role} is duplicated.`);
    byRole.set(source.role, source.locator);
  }
  const missing = OPERATOR_ASSESSMENT_REQUEST_FILES.filter(({ role }) => !byRole.has(role)).map(({ role }) => role);
  if (missing.length > 0) throw new Error(`Operator assessment bundle is missing roles: ${missing.join(", ")}.`);
  return byRole;
}

function validateExistingBundle(
  bundlePath: string,
  sourceFiles: readonly { readonly name: string; readonly bytes: Buffer }[],
  manifestBytes: Buffer,
): void {
  assertNonLinkDirectory(bundlePath, "Existing operator assessment bundle");
  for (const file of sourceFiles) {
    if (!readRegular(join(bundlePath, file.name), `Existing operator assessment ${file.name}`).equals(file.bytes)) {
      throw new Error("Write-once operator assessment bundle already exists with different bytes.");
    }
  }
  if (!readRegular(join(bundlePath, "manifest.json"), "Existing operator assessment manifest").equals(manifestBytes)) {
    throw new Error("Write-once operator assessment bundle already exists with different identity.");
  }
}

export function constructOperatorAssessmentRequestBundle(input: {
  readonly repoRoot: string;
  readonly exchangeRoot: string;
  readonly emittedAt: string;
  readonly expiresAt: string;
  readonly sources: readonly OperatorAssessmentRequestSource[];
}): { readonly bundlePath: string; readonly manifest: OperatorAssessmentRequestManifest } {
  const locators = sourceLocators(input.sources);
  const sourcePaths = new Map<OperatorAssessmentRequestRole, string>(OPERATOR_ASSESSMENT_REQUEST_FILES.map(({ role }) => [
    role,
    repoFile(input.repoRoot, locators.get(role)!, `Assessment handoff ${role}`),
  ]));
  const requestPath = sourcePaths.get("assessment_request")!;
  const requestBytes = readRegular(requestPath, "Operator assessment request");
  assertNoSecretLikeContent(requestBytes, "Operator assessment request");
  const request = record(JSON.parse(requestBytes.toString("utf8")), "Operator assessment request");
  if (request.schemaVersion !== REQUEST_SCHEMA || request.state !== "awaiting_assessment") {
    throw new Error("Operator assessment request schema or state is invalid.");
  }
  const runId = nonEmpty(request.runId, "request.runId");
  if (!SAFE_RUN_ID.test(runId)) throw new Error("Operator assessment request run ID is invalid.");
  if (!Number.isSafeInteger(request.requestSequence) || (request.requestSequence as number) < 1) {
    throw new Error("Operator assessment request sequence is invalid.");
  }
  const requestSequence = request.requestSequence as number;
  const requestSha256 = sha256(request.requestSha256, "request.requestSha256");
  const continuationNonce = sha256(request.continuationNonce, "request.continuationNonce");
  const requestBody = { ...request };
  delete requestBody.requestSha256;
  if (canonicalJsonSha256(requestBody) !== requestSha256) {
    throw new Error("Operator assessment request canonical identity drifted.");
  }
  const emittedAt = timestamp(input.emittedAt, "handoff emittedAt");
  const expiresAt = timestamp(input.expiresAt, "handoff expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(emittedAt)) throw new Error("Operator assessment handoff must expire after emission.");

  const sourceFiles = OPERATOR_ASSESSMENT_REQUEST_FILES.map(({ role, name }) => {
    const locator = locators.get(role)!;
    const sealedLocator = requestLocator(request, role);
    if (sealedLocator !== undefined && locator !== sealedLocator) {
      throw new Error(`Operator assessment ${role} locator disagrees with its request binding.`);
    }
    const bytes = role === "assessment_request"
      ? requestBytes
      : readRegular(sourcePaths.get(role)!, `Operator assessment ${role}`);
    assertNoSecretLikeContent(bytes, `Operator assessment ${role}`);
    const sealedSha256 = requestContentSha256(request, role);
    if (sealedSha256 !== undefined && sha256Bytes(bytes) !== sealedSha256) {
      throw new Error(`Operator assessment ${role} disagrees with its request-sealed content identity.`);
    }
    return { role, name, bytes };
  });
  const files = sourceFiles.map(({ role, name, bytes }) => ({
    role,
    path: name,
    contentSha256: sha256Bytes(bytes),
    byteLength: bytes.byteLength,
  }));
  const body = {
    schemaVersion: HANDOFF_SCHEMA,
    state: "awaiting_evaluator" as const,
    runId,
    requestSequence,
    requestSha256,
    continuationNonce,
    emittedAt,
    expiresAt,
    files,
  };
  const manifest: OperatorAssessmentRequestManifest = { ...body, manifestSha256: canonicalJsonSha256(body) };
  const manifestBytes = Buffer.from(prettyCanonicalJson(manifest), "utf8");

  const exchangeRoot = resolve(input.exchangeRoot);
  assertNonLinkDirectory(exchangeRoot, "Roadmap shadow exchange root");
  const sessionsRoot = join(exchangeRoot, "sessions");
  assertNonLinkDirectory(sessionsRoot, "Roadmap shadow sessions root");
  const runRoot = join(sessionsRoot, runId);
  assertNonLinkDirectory(runRoot, "Operator assessment session root");
  const requestsRoot = join(runRoot, "requests");
  if (!existsSync(requestsRoot)) mkdirSync(requestsRoot, { mode: 0o700 });
  assertNonLinkDirectory(requestsRoot, "Operator assessment requests root");
  const bundlePath = join(requestsRoot, `${String(requestSequence).padStart(4, "0")}-${requestSha256}`);
  if (existsSync(bundlePath)) {
    validateExistingBundle(bundlePath, sourceFiles, manifestBytes);
    return { bundlePath, manifest };
  }

  const temporary = join(runRoot, `.tmp-${randomUUID()}`);
  mkdirSync(temporary, { mode: 0o700 });
  assertNonLinkDirectory(temporary, "Temporary operator assessment bundle");
  try {
    for (const file of sourceFiles) writeExclusive(join(temporary, file.name), file.bytes);
    writeExclusive(join(temporary, "manifest.json"), manifestBytes);
    renameSync(temporary, bundlePath);
  } catch (error) {
    if (existsSync(temporary)) {
      assertNonLinkDirectory(temporary, "Temporary operator assessment bundle cleanup target");
      rmSync(temporary, { recursive: true, force: false });
    }
    throw error;
  }
  validateExistingBundle(bundlePath, sourceFiles, manifestBytes);
  return { bundlePath, manifest };
}

export function authorOperatorAssessmentRequestBundle(input: {
  readonly dispositionHistory: DispositionHistoryLookup;
  readonly repoRoot: string;
  readonly exchangeRoot: string;
  readonly scheduledExchangeRoot: string;
  readonly candidateLocator: string;
  readonly intakeSnapshotLocator: string;
  readonly trustedMainSha: string;
  readonly now: Date;
  readonly runDiscriminator?: string;
  readonly deadlineMs?: number;
  readonly promptLocator?: string;
  readonly stackLocator?: string;
  readonly assessmentSchemaLocator?: string;
}): AuthoredOperatorAssessmentRequestBundle {
  if (typeof input.dispositionHistory !== "function") {
    throw new Error("disposition_history_unavailable: no history lookup injected");
  }
  if (sameResolvedPath(input.exchangeRoot, input.scheduledExchangeRoot)) {
    throw new Error("Operator assessment exchange root must not equal the scheduled roadmap shadow exchange root.");
  }
  const deadlineMs = input.deadlineMs ?? DEFAULT_OPERATOR_ASSESSMENT_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60 * 60 * 1000) {
    throw new Error("Operator assessment deadline must be between 1 millisecond and 1 hour.");
  }
  const runId = runIdFor(input.now, input.runDiscriminator);
  const startedAt = input.now.toISOString();
  const deadlineAt = new Date(input.now.getTime() + deadlineMs).toISOString();
  const candidateSource = repoFile(input.repoRoot, input.candidateLocator, "Operator candidate sidecar");
  const snapshotSource = repoFile(input.repoRoot, input.intakeSnapshotLocator, "Operator intake snapshot");
  const promptSourceLocator = input.promptLocator ?? DEFAULT_ASSESSMENT_PROMPT_LOCATOR;
  const stackSourceLocator = input.stackLocator ?? DEFAULT_ASSESSMENT_STACK_LOCATOR;
  const schemaSourceLocator = input.assessmentSchemaLocator ?? DEFAULT_ASSESSMENT_SCHEMA_LOCATOR;
  const promptSource = repoFile(input.repoRoot, promptSourceLocator, "Operator assessment prompt");
  const stackSource = repoFile(input.repoRoot, stackSourceLocator, "Operator assessment stack");
  const schemaSource = repoFile(input.repoRoot, schemaSourceLocator, "Operator assessment schema");

  const candidateBytes = readRegular(candidateSource, "Operator candidate sidecar");
  const snapshotBytes = readRegular(snapshotSource, "Operator intake snapshot");
  const promptBytes = readRegular(promptSource, "Operator assessment prompt");
  const stackBytes = readRegular(stackSource, "Operator assessment stack");
  const schemaBytes = readRegular(schemaSource, "Operator assessment schema");
  for (const [context, bytes] of [
    ["Operator candidate sidecar", candidateBytes],
    ["Operator intake snapshot", snapshotBytes],
    ["Operator assessment prompt", promptBytes],
    ["Operator assessment stack", stackBytes],
    ["Operator assessment schema", schemaBytes],
  ] as const) assertNoSecretLikeContent(bytes, context);

  const envelope = parseOutcomeEnvelope(JSON.parse(candidateBytes.toString("utf8")));
  const history = input.dispositionHistory(input.trustedMainSha, { repoRoot: input.repoRoot });
  const selection = effectiveOutcomeCandidates(envelope, history);
  const envelopeSha256 = canonicalJsonSha256(envelope);
  const snapshot = parseIntakeSnapshotV1(JSON.parse(snapshotBytes.toString("utf8")));
  if (snapshot.candidateSha256 !== envelopeSha256) {
    throw new Error("Operator intake snapshot is not bound to the supplied outcome candidate sidecar.");
  }
  const descriptor = parseAssessmentStackDescriptor(
    JSON.parse(stackBytes.toString("utf8")),
    promptBytes.toString("utf8"),
    promptSourceLocator,
  );
  const assessmentStack = stackIdentity(descriptor);
  const assessmentStackHash = assessmentStackSha256(assessmentStack);
  // The scheduled path sorts these through `sortedFingerprints`, which also validates each is a
  // lowercase SHA-256 and rejects duplicates. A bare sort is equivalent here ONLY because
  // `parseOutcomeEnvelope` has already enforced both -- it validates every `sourceFingerprint`
  // against its derived identity and rejects duplicate fingerprints -- and because the two
  // comparators agree on lowercase hex. If that parser ever stops guaranteeing either, this
  // derivation silently diverges from the scheduled one, and `revisionId` carries the divergence
  // into `continuationNonce` and `requestSha256`.
  const sourceFingerprints = selection.active.map(({ sourceFingerprint }) => sourceFingerprint).sort();
  const revisionId = canonicalJsonSha256({ envelopeSha256, sourceFingerprints });
  const continuationNonce = canonicalJsonSha256({
    runId,
    revisionId,
    requestSequence: 1,
    envelopeSha256,
    snapshotContentSha256: snapshot.contentSha256,
    assessmentStackSha256: assessmentStackHash,
  });

  const artifactRoot = ensureRepoArtifactRoot(input.repoRoot, runId);
  const archived = {
    candidate: join(artifactRoot, "candidate-envelope.json"),
    snapshot: join(artifactRoot, "intake-snapshot.json"),
    prompt: join(artifactRoot, "assessment-prompt.md"),
    stack: join(artifactRoot, "assessment-stack.json"),
    schema: join(artifactRoot, "assessment-schema.json"),
    request: join(artifactRoot, "assessment-request.json"),
  } as const;
  writeOnce(archived.candidate, candidateBytes, "Archived operator candidate");
  writeOnce(archived.snapshot, snapshotBytes, "Archived operator intake snapshot");
  writeOnce(archived.prompt, promptBytes, "Archived operator assessment prompt");
  writeOnce(archived.stack, stackBytes, "Archived operator assessment stack");
  writeOnce(archived.schema, schemaBytes, "Archived operator assessment schema");
  const locators = {
    candidate: locatorFromRepo(input.repoRoot, archived.candidate),
    snapshot: locatorFromRepo(input.repoRoot, archived.snapshot),
    prompt: locatorFromRepo(input.repoRoot, archived.prompt),
    stack: locatorFromRepo(input.repoRoot, archived.stack),
    schema: locatorFromRepo(input.repoRoot, archived.schema),
    request: locatorFromRepo(input.repoRoot, archived.request),
  } as const;
  const requestBody = {
    schemaVersion: REQUEST_SCHEMA,
    state: "awaiting_assessment" as const,
    runId,
    revisionId,
    requestSequence: 1,
    continuationNonce,
    envelopeSha256,
    archivedCandidate: { locator: locators.candidate, contentSha256: sha256Bytes(candidateBytes) },
    skipped: intakeDispositionSkips(envelope, history),
    candidates: selection.active.map(({ sourceFingerprint, emissionContentSha256 }) => ({
      sourceFingerprint,
      emissionContentSha256,
    })).sort((left, right) => left.sourceFingerprint.localeCompare(right.sourceFingerprint, "en")),
    intakeSnapshot: {
      locator: locators.snapshot,
      contentSha256: snapshot.contentSha256,
      fileSha256: sha256Bytes(snapshotBytes),
      coverageSha256: intakeSnapshotCoverageSha256(snapshot),
    },
    assessmentStack,
    assessmentStackSha256: assessmentStackHash,
    prompt: { locator: locators.prompt, contentSha256: sha256Bytes(promptBytes) },
    stackDescriptor: { locator: locators.stack, contentSha256: sha256Bytes(stackBytes) },
    assessmentSchema: { locator: locators.schema, contentSha256: sha256Bytes(schemaBytes) },
    assessmentTarget: `${locatorFromRepo(input.repoRoot, artifactRoot)}/assessment.json`,
    shadowReportTarget: `${locatorFromRepo(input.repoRoot, artifactRoot)}/shadow-report.json`,
  };
  const request = { ...requestBody, requestSha256: canonicalJsonSha256(requestBody) };
  writeOnce(
    archived.request,
    Buffer.from(prettyCanonicalJson(request), "utf8"),
    "Operator assessment request",
  );

  const runRoot = startOperatorEvaluationSession({
    exchangeRoot: input.exchangeRoot,
    scheduledExchangeRoot: input.scheduledExchangeRoot,
    runId,
    trustedMainSha: input.trustedMainSha,
    startedAt,
    deadlineAt,
  });
  const sources: readonly OperatorAssessmentRequestSource[] = [
    { role: "assessment_request", locator: locators.request },
    { role: "candidate_envelope", locator: locators.candidate },
    { role: "intake_snapshot", locator: locators.snapshot },
    { role: "assessment_prompt", locator: locators.prompt },
    { role: "assessment_stack", locator: locators.stack },
    { role: "assessment_schema", locator: locators.schema },
  ];
  const constructed = constructOperatorAssessmentRequestBundle({
    repoRoot: input.repoRoot,
    exchangeRoot: input.exchangeRoot,
    emittedAt: startedAt,
    expiresAt: deadlineAt,
    sources,
  });
  const files = Object.fromEntries(constructed.manifest.files.map(({ role, path }) => [
    role,
    join(constructed.bundlePath, path),
  ])) as unknown as Readonly<Record<OperatorAssessmentRequestRole, string>>;
  const handoff: OperatorAssessmentHandoff = {
    schemaVersion: OPERATOR_HANDOFF_SCHEMA,
    runId,
    exchangeRoot: resolve(input.exchangeRoot),
    bundlePath: constructed.bundlePath,
    assessmentTarget: join(runRoot, "responses", basename(constructed.bundlePath), "assessment.input.json"),
    files,
  };
  const operatorHandoffPath = join(runRoot, "operator-handoff.json");
  writeOnce(
    operatorHandoffPath,
    Buffer.from(prettyCanonicalJson(handoff), "utf8"),
    "Operator assessment handoff",
  );
  return {
    runId,
    requestLocator: locators.request,
    bundlePath: constructed.bundlePath,
    operatorHandoffPath,
    handoff,
    manifest: constructed.manifest,
  };
}
