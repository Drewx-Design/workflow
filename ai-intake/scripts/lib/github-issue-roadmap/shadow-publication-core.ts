import { createHash } from "node:crypto";

import { canonicalJson, canonicalJsonSha256, prettyCanonicalJson } from "./canonical-json";
import type { IntakeAttemptRecord, IntakeObservationRecord } from "./intake-observation";
import { OUTCOME_ENVELOPE_SCHEMA_VERSIONS } from "./outcome-candidate";

export const SHADOW_PUBLICATION_VALIDATOR_VERSION = "github-issue-roadmap-shadow-publication-validator/v1" as const;
export const SHADOW_PUBLISH_MANIFEST_SCHEMA_VERSION = "github-issue-roadmap-shadow-publish-manifest/v1" as const;
export const SHADOW_REFRESHED_PUBLISH_MANIFEST_SCHEMA_VERSION = "github-issue-roadmap-shadow-refreshed-publish-manifest/v1" as const;
export const SHADOW_ROLLING_BRANCH = "codex/roadmap-shadow-observations" as const;

const COLLECTION_SCHEMA = "github-issue-roadmap-shadow-collection-manifest/v1";
export const SHADOW_PUBLICATION_OBSERVATION_SCHEMAS = [
  "github-issue-roadmap-provisional-observation-input/v1",
  "github-issue-roadmap-provisional-observation-input/v2",
] as const;
const ATTEMPT_SCHEMA = "github-issue-roadmap-provisional-observation-attempt/v1";
const SNAPSHOT_SCHEMA = "github-issue-roadmap-intake-snapshot/v1";
const ARTIFACT_ROOT = "artifacts/github-issue-roadmap/";
const OBSERVATION_ROOT = `${ARTIFACT_ROOT}observations/`;
const ATTEMPT_ROOT = `${ARTIFACT_ROOT}attempts/`;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const SAFE_RUN_ID = /^(?=.{1,128}$)(?=.*[^.])[A-Za-z0-9._-]+$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_DURABLE_BYTES = 64 * 1024 * 1024;
const MAX_JSON_STRING_BYTES = 256 * 1024;

type JsonObject = Record<string, unknown>;

export interface PublicationArtifact {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mode: string;
  readonly objectType: string;
  readonly linkOrReparsePoint: boolean;
  readonly identityStable: boolean;
}

export interface PublicationInventoryEntry {
  readonly path: string;
  readonly contentSha256: string;
  readonly mode: "100644";
  readonly objectType: "blob";
}

export type PublicationParsedJournalRecord = IntakeObservationRecord | IntakeAttemptRecord;

function isObservationRecord(record: PublicationParsedJournalRecord): record is IntakeObservationRecord {
  return (SHADOW_PUBLICATION_OBSERVATION_SCHEMAS as readonly string[]).includes(record.schemaVersion);
}

export interface PublicationJournalRecord {
  readonly path: string;
  readonly record: PublicationParsedJournalRecord;
}

export type PublicationTransition =
  | Readonly<{ tag: "create"; leaseSha: null; orderedParents: readonly [string] }>
  | Readonly<{ tag: "same_main"; leaseSha: string; orderedParents: readonly [string] }>
  | Readonly<{ tag: "advanced_main"; leaseSha: string; orderedParents: readonly [string, string] }>;

export interface ShadowPublicationInput {
  readonly validatorVersion?: string;
  readonly originIdentity: string;
  readonly trustedMainSha: string;
  readonly transition: PublicationTransition;
  readonly collectionManifestPath: string;
  readonly initialInventory: readonly PublicationInventoryEntry[];
  readonly currentArtifacts: readonly PublicationArtifact[];
  readonly journalRecords: readonly PublicationJournalRecord[];
}

export interface ShadowPublishManifest {
  readonly schemaVersion: typeof SHADOW_PUBLISH_MANIFEST_SCHEMA_VERSION;
  readonly validatorVersion: string;
  readonly originIdentity: string;
  readonly trustedMainSha: string;
  readonly runId: string;
  readonly collectionStatus: string;
  readonly collectionManifestPath: string;
  readonly collectionManifestSha256: string;
  readonly transition: PublicationTransition;
  readonly blobs: readonly PublicationInventoryEntry[];
  readonly expectedOutputTreeSha256: string;
  readonly manifestSha256: string;
}

export interface ShadowPublicationResult {
  readonly publishManifest: ShadowPublishManifest;
  readonly publishManifestBytes: string;
  readonly publishManifestPath: string;
  readonly bundleSha256: string;
  readonly files: readonly PublicationArtifact[];
}

export interface ShadowPublicationTransitionInput {
  readonly trustedMainSha: string;
  readonly remoteLeaseSha: string | null;
  readonly remoteMainSha: string | null;
  readonly retainedPublishedDispositionCount: number;
}

export interface RefreshedShadowPublishManifest {
  readonly schemaVersion: typeof SHADOW_REFRESHED_PUBLISH_MANIFEST_SCHEMA_VERSION;
  readonly validatorVersion: string;
  readonly originIdentity: string;
  readonly trustedMainSha: string;
  readonly branch: typeof SHADOW_ROLLING_BRANCH;
  readonly generatedAt: string;
  readonly transition: PublicationTransition;
  readonly inputBundleSha256s: readonly string[];
  readonly blobs: readonly PublicationInventoryEntry[];
  readonly expectedOutputTreeSha256: string;
  readonly manifestSha256: string;
}

export interface RefreshedShadowPublication {
  readonly status: "ready" | "zero_delta";
  readonly manifest: RefreshedShadowPublishManifest;
  readonly manifestBytes: string;
  readonly manifestPath: string;
  /** Exact immutable bytes used by the publisher; no mutable collection path needs rereading. */
  readonly files: readonly PublicationArtifact[];
  readonly inputBundleSha256s: readonly string[];
  readonly transition: PublicationTransition;
}

export interface CohortObservation {
  readonly observationId: string;
  readonly observedAt: string;
}

export const COHORT_OBSERVATION_COUNT_GATE = 10;
export const COHORT_ELAPSED_TIME_GATE_MS = 7 * 24 * 60 * 60 * 1000;

export interface CohortThresholdEvaluation {
  readonly status: "below_threshold" | "opened";
  readonly trigger: "count" | "elapsed_time" | null;
  readonly observationIds: readonly string[];
  readonly observationCount: number;
  readonly countGate: typeof COHORT_OBSERVATION_COUNT_GATE;
  readonly countGateRemaining: number;
  readonly firstObservationAt: string | null;
  readonly timeGateAt: string | null;
}

export interface CohortCheckpoint {
  readonly checkpointId: string;
  readonly openedAt: string;
  readonly firstObservationAt: string;
  readonly observationIds: readonly string[];
  readonly reviewedAt: string | null;
  readonly resetAt: string | null;
}

export interface CohortCheckpointEvaluation {
  readonly status: "below_threshold" | "opened" | "already_open" | "reviewed";
  readonly checkpoint: CohortCheckpoint | null;
  /** Present only when this evaluation tested a new post-reset cohort against the gate. */
  readonly threshold: CohortThresholdEvaluation | null;
}

interface CollectionEntry {
  readonly revisionId: string;
  readonly envelopeSha256: string;
  readonly sourceFingerprints: readonly string[];
  readonly selected: boolean;
  readonly terminalState: string;
}

interface CollectionManifest {
  readonly runId: string;
  readonly status: string;
  readonly trustedMainSha: string;
  readonly counts: Readonly<Record<string, number>>;
  readonly entries: readonly CollectionEntry[];
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256Bytes(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function object(value: unknown, context: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, keys: readonly string[], context: string): void {
  const actual = Object.keys(value).sort(lexical);
  const expected = [...keys].sort(lexical);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`${context} must contain exact keys [${expected.join(", ")}].`);
  }
}

function sha256(value: unknown, context: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${context} must be a lowercase SHA-256.`);
  return value;
}

function gitSha(value: unknown, context: string): string {
  if (typeof value !== "string" || !GIT_SHA.test(value)) throw new Error(`${context} must be a lowercase 40-character Git SHA.`);
  return value;
}

function canonicalPath(value: string, context: string): string {
  if (typeof value !== "string" || value === "" || value !== value.normalize("NFC") || value.includes("\\") ||
      value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new Error(`${context} must be a canonical repository-relative path.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes(":") ||
      /^\.git/i.test(segment) || WINDOWS_DEVICE.test(segment))) {
    throw new Error(`${context} contains a path escape, Git metadata, device, or alternate-stream form.`);
  }
  if (!value.startsWith(ARTIFACT_ROOT)) throw new Error(`${context} must stay below ${ARTIFACT_ROOT}.`);
  return value;
}

function collisionIdentity(path: string): string {
  return path.normalize("NFKC").toLocaleLowerCase("en-US");
}

function validatePathSet(paths: readonly string[], context: string): void {
  const seen = new Map<string, string>();
  for (const pathValue of paths) {
    const path = canonicalPath(pathValue, context);
    const identity = collisionIdentity(path);
    const prior = seen.get(identity);
    if (prior !== undefined) throw new Error(`${context} paths ${prior} and ${path} collide by case or Unicode identity.`);
    seen.set(identity, path);
  }
}

function json(bytes: Uint8Array, context: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${context} must be valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertJsonStringBudgets(value: unknown, context: string): void {
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > MAX_JSON_STRING_BYTES) {
      throw new Error(`${context} contains a string over the publication byte budget.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJsonStringBudgets(child, `${context}[${index}]`));
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value as JsonObject)) assertJsonStringBudgets(child, `${context}.${key}`);
  }
}

function assertNoSecretLikeContent(bytes: Uint8Array, context: string): void {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9]{24,})\b/,
  ];
  if (patterns.some((pattern) => pattern.test(text))) throw new Error(`${context} contains secret-like content.`);
  // The archived review evidence quotes the exact, non-routable DB-free CI
  // sentinel documented in db-free-ci-lanes-carry-a-sentinel-database-url-2026-08-16.md.
  // Omit only that complete assignment from this heuristic, never arbitrary
  // loopback URLs, token variables, or values with a suffix. Scan decoded text
  // for key/token signatures above, and leave the artifact bytes/hash untouched.
  const assignments = text.matchAll(/\b(?:GH_TOKEN|GITHUB_TOKEN|PUBLISHER_TOKEN|DATABASE_URL|OPENAI_API_KEY|ANTHROPIC_API_KEY)\s*[=:]\s*["']?[^\s,"'}]{8,}/gi);
  for (const assignment of assignments) {
    if (/^DATABASE_URL\s*[=:]\s*(["']?)postgres:\/\/ci-db-free-lane:noop@127\.0\.0\.1:1\/noop\1(?=\s|$)/.test(text.slice(assignment.index))) continue;
    throw new Error(`${context} contains secret-like content.`);
  }
}

function validateArtifact(value: PublicationArtifact): PublicationArtifact {
  canonicalPath(value.path, "publication artifact path");
  if (value.mode !== "100644" || value.objectType !== "blob") {
    throw new Error(`Publication artifact ${value.path} must be a non-executable regular blob with mode 100644.`);
  }
  if (value.linkOrReparsePoint || !value.identityStable) {
    throw new Error(`Publication artifact ${value.path} must be a stable non-link, non-reparse-point file.`);
  }
  if (value.bytes.byteLength > MAX_FILE_BYTES) throw new Error(`Publication artifact ${value.path} exceeds the file byte budget.`);
  assertNoSecretLikeContent(value.bytes, value.path);
  return value;
}

function artifactJson(value: PublicationArtifact, context = value.path): unknown {
  const parsed = json(value.bytes, context);
  assertJsonStringBudgets(parsed, context);
  return parsed;
}

function parseCollectionManifest(value: unknown): CollectionManifest {
  const raw = object(value, "sealed collection manifest");
  exactKeys(raw, [
    "schemaVersion", "phase", "status", "runId", "generatedAt", "trustedMainSha", "rollingInputSha",
    "expectedRemoteLease", "counts", "entries", "integrityAlerts", "notifications",
  ], "sealed collection manifest");
  if (raw.schemaVersion !== COLLECTION_SCHEMA || raw.phase !== "sealed") throw new Error("Collection manifest is not a sealed supported schema.");
  if (!["zero_new", "awaiting_operator", "partial_failure", "failed", "spool_saturated"].includes(raw.status as string)) {
    throw new Error("Collection manifest status is unsupported.");
  }
  if (typeof raw.runId !== "string" || !SAFE_RUN_ID.test(raw.runId)) throw new Error("Collection manifest runId is unsafe.");
  gitSha(raw.trustedMainSha, "collection manifest trustedMainSha");
  const counts = object(raw.counts, "collection manifest counts");
  exactKeys(counts, [
    "discovered", "eligible", "alreadyObserved", "awaitingOperator", "explicitEmpty", "attempted",
    "observed", "failed", "deferredByCap",
  ], "collection manifest counts");
  for (const [name, count] of Object.entries(counts)) {
    if (!Number.isSafeInteger(count) || (count as number) < 0) throw new Error(`collection manifest counts.${name} is invalid.`);
  }
  if (!Array.isArray(raw.entries)) throw new Error("Collection manifest entries must be an array.");
  const entries = raw.entries.map((entryValue, index): CollectionEntry => {
    const entry = object(entryValue, `collection manifest entries[${index}]`);
    exactKeys(entry, [
      "revisionId", "envelopeSha256", "sourceLocator", "candidateLocator", "completedAt", "sourceFingerprints",
      "selected", "previouslyDeferred", "terminalState",
    ], `collection manifest entries[${index}]`);
    const revisionId = sha256(entry.revisionId, `entries[${index}].revisionId`);
    const envelopeSha256 = sha256(entry.envelopeSha256, `entries[${index}].envelopeSha256`);
    if (!Array.isArray(entry.sourceFingerprints)) throw new Error(`entries[${index}].sourceFingerprints must be an array.`);
    const sourceFingerprints = entry.sourceFingerprints.map((item, itemIndex) =>
      sha256(item, `entries[${index}].sourceFingerprints[${itemIndex}]`)).sort(lexical);
    if (new Set(sourceFingerprints).size !== sourceFingerprints.length) throw new Error("Collection manifest fingerprints contain duplicates.");
    if (revisionId !== canonicalJsonSha256({ envelopeSha256, sourceFingerprints })) {
      throw new Error(`entries[${index}].revisionId disagrees with its envelope and fingerprint identity.`);
    }
    if (typeof entry.sourceLocator !== "string" || entry.sourceLocator.trim() === "" ||
        typeof entry.candidateLocator !== "string" || entry.candidateLocator.trim() === "" ||
        typeof entry.completedAt !== "string" || !Number.isFinite(Date.parse(entry.completedAt)) ||
        typeof entry.selected !== "boolean" || typeof entry.previouslyDeferred !== "boolean" ||
        typeof entry.terminalState !== "string" || ![
          "explicit_empty", "collected_complete", "published_verified", "observed", "failed", "deferred_by_cap",
        ].includes(entry.terminalState)) {
      throw new Error("Collection manifest entry state or provenance is invalid.");
    }
    if ((sourceFingerprints.length === 0) !== (entry.terminalState === "explicit_empty") ||
        (entry.selected !== ["observed", "failed"].includes(entry.terminalState))) {
      throw new Error("Collection manifest selected, explicit-empty, and terminal states disagree.");
    }
    return { revisionId, envelopeSha256, sourceFingerprints, selected: entry.selected, terminalState: entry.terminalState };
  });
  const observed = entries.filter(({ terminalState }) => terminalState === "observed").length;
  const failed = entries.filter(({ terminalState }) => terminalState === "failed").length;
  const awaitingOperator = entries.filter(({ terminalState }) =>
    terminalState === "observed" || terminalState === "collected_complete").length;
  const expectedCounts = {
    discovered: entries.length,
    eligible: entries.filter(({ sourceFingerprints }) => sourceFingerprints.length > 0).length,
    alreadyObserved: entries.filter(({ terminalState }) =>
      terminalState === "collected_complete" || terminalState === "published_verified").length,
    awaitingOperator,
    explicitEmpty: entries.filter(({ terminalState }) => terminalState === "explicit_empty").length,
    attempted: entries.filter(({ selected }) => selected).length,
    observed,
    failed,
    deferredByCap: entries.filter(({ terminalState }) => terminalState === "deferred_by_cap").length,
  };
  if (canonicalJson(counts) !== canonicalJson(expectedCounts)) {
    throw new Error("Collection manifest counts disagree with terminal entries.");
  }
  const expectedStatus = collectionStatus(failed, awaitingOperator);
  if (raw.status !== "spool_saturated" && raw.status !== expectedStatus) {
    throw new Error("Collection manifest status disagrees with its terminal entries.");
  }
  return {
    runId: raw.runId,
    status: raw.status as string,
    trustedMainSha: raw.trustedMainSha as string,
    counts: counts as Record<string, number>,
    entries,
  };
}

function collectionStatus(failed: number, awaitingOperator: number): string {
  if (failed > 0 && awaitingOperator > 0) return "partial_failure";
  if (failed > 0) return "failed";
  if (awaitingOperator > 0) return "awaiting_operator";
  return "zero_new";
}

function validateTransition(value: PublicationTransition, trustedMainSha: string): PublicationTransition {
  const parents = [...value.orderedParents].map((parent, index) => gitSha(parent, `transition.orderedParents[${index}]`));
  if (value.tag === "create") {
    if (value.leaseSha !== null || parents.length !== 1 || parents[0] !== trustedMainSha) {
      throw new Error("create transition requires a null lease and ordered parents [trustedMainSha].");
    }
  } else if (value.tag === "same_main") {
    const lease = gitSha(value.leaseSha, "transition.leaseSha");
    if (parents.length !== 1 || parents[0] !== lease) throw new Error("same_main transition requires ordered parents [lease].");
  } else if (value.tag === "advanced_main") {
    const lease = gitSha(value.leaseSha, "transition.leaseSha");
    if (parents.length !== 2 || parents[0] !== lease || parents[1] !== trustedMainSha) {
      throw new Error("advanced_main transition requires ordered parents [lease, trustedMainSha].");
    }
  } else {
    throw new Error("Publication transition tag is unsupported.");
  }
  return value;
}

function validateCandidate(bytes: Uint8Array, expectedSha256: string, context: string): void {
  const value = object(json(bytes, context), context);
  assertJsonStringBudgets(value, context);
  if (!OUTCOME_ENVELOPE_SCHEMA_VERSIONS.some((version) => value.schemaVersion === version)) {
    throw new Error(`${context} has an unsupported candidate-envelope schema.`);
  }
  if (canonicalJsonSha256(value) !== expectedSha256) throw new Error(`${context} candidate-envelope hash drifted.`);
}

function validateSnapshot(bytes: Uint8Array, expectedSha256: string, candidateSha256: string, context: string): void {
  const value = object(json(bytes, context), context);
  assertJsonStringBudgets(value, context);
  if (value.schemaVersion !== SNAPSHOT_SCHEMA) throw new Error(`${context} has an unsupported intake-snapshot schema.`);
  if (value.contentSha256 !== expectedSha256 || value.candidateSha256 !== candidateSha256) {
    throw new Error(`${context} snapshot binding hash drifted.`);
  }
  const core = {
    candidateSha256: value.candidateSha256,
    canonicalSnapshotV2Sha256: value.canonicalSnapshotV2Sha256,
    repository: value.repository,
    censusContentSha256: value.censusContentSha256,
    issues: value.issues,
    markerIndex: value.markerIndex,
    markerIncidents: value.markerIncidents,
    projectObservation: value.projectObservation,
    receipts: value.receipts,
  };
  if (canonicalJsonSha256(core) !== expectedSha256) throw new Error(`${context} snapshot content hash drifted.`);
}

function entryLocatorPrefix(manifest: CollectionManifest, entry: CollectionEntry): string {
  const selected = manifest.entries.filter(({ selected }) => selected);
  const sequence = selected.findIndex(({ revisionId }) => revisionId === entry.revisionId) + 1;
  if (sequence < 1) throw new Error(`Collection entry ${entry.revisionId} is not selected and cannot own journal additions.`);
  return `${ARTIFACT_ROOT}shadow-runs/${manifest.runId}/entries/${String(sequence).padStart(4, "0")}-${entry.revisionId}/`;
}

function entryForCandidate(manifest: CollectionManifest, locator: string, hash: string): CollectionEntry {
  canonicalPath(locator, "journal candidate locator");
  const matches = manifest.entries.filter((entry) => entry.selected && locator === `${entryLocatorPrefix(manifest, entry)}candidate-envelope.json`);
  if (matches.length !== 1) throw new Error(`Journal candidate locator ${locator} has no exact collection-manifest membership.`);
  if (matches[0].envelopeSha256 !== hash) throw new Error(`Journal candidate locator ${locator} has hash drift.`);
  return matches[0];
}

function publicationInventory(artifact: PublicationArtifact): PublicationInventoryEntry {
  return { path: artifact.path, contentSha256: sha256Bytes(artifact.bytes), mode: "100644", objectType: "blob" };
}

export function deriveShadowPublication(input: ShadowPublicationInput): ShadowPublicationResult {
  const trustedMainSha = gitSha(input.trustedMainSha, "trustedMainSha");
  if (!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(input.originIdentity)) throw new Error("originIdentity must be owner/repository.");
  if (typeof input.validatorVersion !== "undefined" && input.validatorVersion.trim() === "") throw new Error("validatorVersion must be non-empty.");
  const validatorVersion = input.validatorVersion ?? SHADOW_PUBLICATION_VALIDATOR_VERSION;
  const transition = validateTransition(input.transition, trustedMainSha);
  validatePathSet(input.initialInventory.map(({ path }) => path), "initial inventory");
  validatePathSet(input.currentArtifacts.map(({ path }) => path), "current artifact inventory");

  const current = new Map<string, PublicationArtifact>();
  for (const artifactValue of input.currentArtifacts) {
    const validated = validateArtifact(artifactValue);
    if (current.has(validated.path)) throw new Error(`Current artifact inventory duplicates ${validated.path}.`);
    current.set(validated.path, validated);
  }

  const initialPaths = new Set<string>();
  for (const prior of input.initialInventory) {
    canonicalPath(prior.path, "initial inventory path");
    sha256(prior.contentSha256, `initial inventory ${prior.path} hash`);
    if (prior.mode !== "100644" || prior.objectType !== "blob") throw new Error("Initial inventory contains a forbidden tree mode.");
    const present = current.get(prior.path);
    if (present === undefined) throw new Error(`Trusted initial inventory path ${prior.path} was deleted.`);
    if (sha256Bytes(present.bytes) !== prior.contentSha256 || present.mode !== prior.mode || present.objectType !== prior.objectType) {
      throw new Error(`Trusted initial inventory path ${prior.path} was modified or changed hash/mode.`);
    }
    initialPaths.add(prior.path);
  }
  const additions = [...current.values()].filter(({ path }) => !initialPaths.has(path));
  const additionBytes = additions.reduce((total, artifact) => total + artifact.bytes.byteLength, 0);
  if (!Number.isSafeInteger(additionBytes) || additionBytes > MAX_DURABLE_BYTES) {
    throw new Error("Publication durable-run byte budget exceeded.");
  }
  const additionsByPath = new Map(additions.map((entry) => [entry.path, entry]));
  const collectionArtifact = additionsByPath.get(canonicalPath(input.collectionManifestPath, "collection manifest path"));
  if (collectionArtifact === undefined) throw new Error("Sealed collection manifest is missing from the exact additions.");
  const collection = parseCollectionManifest(artifactJson(collectionArtifact, "sealed collection manifest"));
  if (collection.trustedMainSha !== trustedMainSha) throw new Error("Collection manifest trustedMainSha disagrees with validator input.");
  const expectedCollectionPath = `${ARTIFACT_ROOT}shadow-runs/${collection.runId}/collection-manifest.json`;
  if (collectionArtifact.path !== expectedCollectionPath) throw new Error("Collection manifest path does not match its runId.");

  const journalByPath = new Map<string, PublicationParsedJournalRecord>();
  for (const parsed of input.journalRecords) {
    canonicalPath(parsed.path, "parsed journal path");
    if (journalByPath.has(parsed.path)) throw new Error(`Parsed journal record ${parsed.path} is duplicated.`);
    const artifactValue = additionsByPath.get(parsed.path);
    if (artifactValue === undefined) throw new Error(`Parsed journal record ${parsed.path} is not an exact addition.`);
    const raw = artifactJson(artifactValue);
    if (canonicalJson(raw) !== canonicalJson(parsed.record)) {
      throw new Error(`Parsed journal record ${parsed.path} disagrees with its exact bytes or schema.`);
    }
    journalByPath.set(parsed.path, parsed.record);
  }

  const allowed = new Set<string>([collectionArtifact.path]);
  const neededCandidateHashes = new Map<string, string>();
  const neededSnapshotHashes = new Map<string, { snapshot: string; candidate: string }>();
  const observedFingerprints = new Map<string, Set<string>>();
  for (const [path, record] of journalByPath) {
    const expectedRoot = isObservationRecord(record) ? OBSERVATION_ROOT :
      record.schemaVersion === ATTEMPT_SCHEMA ? ATTEMPT_ROOT : null;
    if (expectedRoot === null) throw new Error(`Parsed journal record ${path} has an unsupported schema.`);
    const identity = isObservationRecord(record) ? record.observationId : record.attemptId;
    sha256(identity, `${path} identity`);
    if (path !== `${expectedRoot}${identity}.json`) throw new Error(`Parsed journal record ${path} has a noncanonical identity path.`);
    allowed.add(path);

    if (isObservationRecord(record)) {
      const entry = entryForCandidate(collection, record.candidate.locator, record.candidate.contentSha256);
      if (entry.terminalState !== "observed" || !entry.sourceFingerprints.includes(record.candidate.sourceFingerprint)) {
        throw new Error(`Observation ${identity} is not an exact member of an observed collection entry.`);
      }
      const prefix = entryLocatorPrefix(collection, entry);
      if (record.snapshot.locator !== `${prefix}intake-snapshot.json`) {
        throw new Error(`Observation ${identity} snapshot locator has no exact collection-manifest membership.`);
      }
      neededCandidateHashes.set(record.candidate.locator, record.candidate.contentSha256);
      neededSnapshotHashes.set(record.snapshot.locator, {
        snapshot: record.snapshot.contentSha256,
        candidate: record.candidate.contentSha256,
      });
      const fingerprints = observedFingerprints.get(entry.revisionId) ?? new Set<string>();
      if (fingerprints.has(record.candidate.sourceFingerprint)) throw new Error("Duplicate observation exists for one collection fingerprint.");
      fingerprints.add(record.candidate.sourceFingerprint);
      observedFingerprints.set(entry.revisionId, fingerprints);
    } else {
      if (record.bindings.candidate === null) {
        throw new Error(`Attempt ${identity} has no candidate binding, so exact collection-manifest membership cannot be established.`);
      }
      const entry = entryForCandidate(collection, record.bindings.candidate.locator, record.bindings.candidate.contentSha256);
      neededCandidateHashes.set(record.bindings.candidate.locator, record.bindings.candidate.contentSha256);
      if (record.bindings.snapshot !== null) {
        const expectedSnapshot = `${entryLocatorPrefix(collection, entry)}intake-snapshot.json`;
        if (record.bindings.snapshot.locator !== expectedSnapshot) throw new Error(`Attempt ${identity} snapshot locator is not manifest-bound.`);
        neededSnapshotHashes.set(record.bindings.snapshot.locator, {
          snapshot: record.bindings.snapshot.contentSha256,
          candidate: record.bindings.candidate.contentSha256,
        });
      }
    }
  }

  for (const entry of collection.entries.filter(({ terminalState }) => terminalState === "observed")) {
    const actual = observedFingerprints.get(entry.revisionId) ?? new Set<string>();
    if (canonicalJson([...actual].sort(lexical)) !== canonicalJson([...entry.sourceFingerprints].sort(lexical))) {
      throw new Error(`Observed collection entry ${entry.revisionId} lacks its exact journal fingerprint membership.`);
    }
  }
  if (journalByPath.size === 0 && collection.entries.some(({ terminalState }) => terminalState === "observed" || terminalState === "failed")) {
    throw new Error("Collection manifest has attempted entries but no parsed journal additions.");
  }

  for (const [path, expectedHash] of neededCandidateHashes) {
    const candidate = additionsByPath.get(path);
    if (candidate === undefined) throw new Error(`Referenced candidate locator ${path} is missing.`);
    validateCandidate(candidate.bytes, expectedHash, path);
    allowed.add(path);
  }
  for (const [path, hashes] of neededSnapshotHashes) {
    const snapshot = additionsByPath.get(path);
    if (snapshot === undefined) throw new Error(`Referenced snapshot locator ${path} is missing.`);
    validateSnapshot(snapshot.bytes, hashes.snapshot, hashes.candidate, path);
    allowed.add(path);
  }

  const unmanifested = additions.filter(({ path }) => !allowed.has(path));
  if (unmanifested.length > 0) {
    throw new Error(`Publication allowlist rejects unmanifested or prohibited additions: ${unmanifested.map(({ path }) => path).sort(lexical).join(", ")}.`);
  }
  const evidence = additions.filter(({ path }) => allowed.has(path)).sort((left, right) => lexical(left.path, right.path));
  const blobs = evidence.map(publicationInventory);
  const expectedOutputTreeSha256 = canonicalJsonSha256(blobs);
  const publishManifestPath = `${ARTIFACT_ROOT}shadow-runs/${collection.runId}/publish-manifest.json`;
  const withoutHash = {
    schemaVersion: SHADOW_PUBLISH_MANIFEST_SCHEMA_VERSION,
    validatorVersion,
    originIdentity: input.originIdentity,
    trustedMainSha,
    runId: collection.runId,
    collectionStatus: collection.status,
    collectionManifestPath: collectionArtifact.path,
    collectionManifestSha256: sha256Bytes(collectionArtifact.bytes),
    transition,
    blobs,
    expectedOutputTreeSha256,
  };
  const publishManifest: ShadowPublishManifest = {
    ...withoutHash,
    manifestSha256: canonicalJsonSha256(withoutHash),
  };
  const publishManifestBytes = prettyCanonicalJson(publishManifest);
  const manifestArtifact: PublicationArtifact = {
    path: publishManifestPath,
    bytes: Buffer.from(publishManifestBytes),
    mode: "100644",
    objectType: "blob",
    linkOrReparsePoint: false,
    identityStable: true,
  };
  const bundleSha256 = canonicalJsonSha256({
    publishManifestSha256: publishManifest.manifestSha256,
    publishManifestBlobSha256: sha256Bytes(publishManifestBytes),
    files: [...blobs, publicationInventory(manifestArtifact)].sort((left, right) => lexical(left.path, right.path)),
  });
  return {
    publishManifest,
    publishManifestBytes,
    publishManifestPath,
    bundleSha256,
    files: [...evidence, manifestArtifact],
  };
}

export function chooseShadowPublicationTransition(
  input: ShadowPublicationTransitionInput,
): PublicationTransition {
  const trustedMainSha = gitSha(input.trustedMainSha, "trustedMainSha");
  if (!Number.isSafeInteger(input.retainedPublishedDispositionCount) || input.retainedPublishedDispositionCount < 0) {
    throw new Error("retainedPublishedDispositionCount must be a non-negative integer.");
  }
  if (input.remoteLeaseSha === null) {
    if (input.remoteMainSha !== null) throw new Error("An absent rolling ref cannot claim a remote main parent.");
    if (input.retainedPublishedDispositionCount > 0) {
      throw new Error("published_state_lost: the rolling ref is absent while retained published_verified dispositions exist.");
    }
    return { tag: "create", leaseSha: null, orderedParents: [trustedMainSha] };
  }
  const leaseSha = gitSha(input.remoteLeaseSha, "remoteLeaseSha");
  const remoteMainSha = gitSha(input.remoteMainSha, "remoteMainSha");
  return remoteMainSha === trustedMainSha
    ? { tag: "same_main", leaseSha, orderedParents: [leaseSha] }
    : { tag: "advanced_main", leaseSha, orderedParents: [leaseSha, trustedMainSha] };
}

function exactArtifactInventory(files: readonly PublicationArtifact[]): PublicationInventoryEntry[] {
  validatePathSet(files.map(({ path }) => path), "publication file inventory");
  return files.map((file) => publicationInventory(validateArtifact(file)))
    .sort((left, right) => lexical(left.path, right.path));
}

function validateSealedPublicationResult(publication: ShadowPublicationResult): readonly PublicationArtifact[] {
  sha256(publication.bundleSha256, "spool bundleSha256");
  const manifestArtifact = publication.files.find(({ path }) => path === publication.publishManifestPath);
  if (manifestArtifact === undefined || sha256Bytes(manifestArtifact.bytes) !== sha256Bytes(publication.publishManifestBytes)) {
    throw new Error("Spool bundle publish manifest bytes are missing or substituted.");
  }
  const parsed = object(json(manifestArtifact.bytes, publication.publishManifestPath), "spool publish manifest");
  if (canonicalJson(parsed) !== canonicalJson(publication.publishManifest)) {
    throw new Error("Spool publish manifest object disagrees with its exact bytes.");
  }
  const withoutHash = { ...parsed };
  delete withoutHash.manifestSha256;
  if (parsed.schemaVersion !== SHADOW_PUBLISH_MANIFEST_SCHEMA_VERSION ||
      typeof parsed.manifestSha256 !== "string" || canonicalJsonSha256(withoutHash) !== parsed.manifestSha256) {
    throw new Error("Spool publish manifest schema or canonical identity is invalid.");
  }
  const evidenceFiles = publication.files.filter(({ path }) => path !== publication.publishManifestPath);
  const inventory = exactArtifactInventory(evidenceFiles);
  if (canonicalJson(inventory) !== canonicalJson(parsed.blobs) ||
      canonicalJsonSha256(inventory) !== parsed.expectedOutputTreeSha256) {
    throw new Error("Spool publish manifest exact blob inventory drifted.");
  }
  const allInventory = exactArtifactInventory(publication.files);
  const expectedBundleSha256 = canonicalJsonSha256({
    publishManifestSha256: parsed.manifestSha256,
    publishManifestBlobSha256: sha256Bytes(manifestArtifact.bytes),
    files: allInventory,
  });
  if (expectedBundleSha256 !== publication.bundleSha256) throw new Error("Spool bundle identity/content collision detected.");
  const journalRecords: PublicationJournalRecord[] = evidenceFiles.flatMap((file) =>
    file.path.startsWith(OBSERVATION_ROOT) || file.path.startsWith(ATTEMPT_ROOT)
      ? [{ path: file.path, record: artifactJson(file) as PublicationParsedJournalRecord }]
      : []);
  const rederived = deriveShadowPublication({
    validatorVersion: typeof parsed.validatorVersion === "string" ? parsed.validatorVersion : undefined,
    originIdentity: String(parsed.originIdentity),
    trustedMainSha: String(parsed.trustedMainSha),
    transition: parsed.transition as PublicationTransition,
    collectionManifestPath: String(parsed.collectionManifestPath),
    initialInventory: [],
    currentArtifacts: evidenceFiles,
    journalRecords,
  });
  if (rederived.bundleSha256 !== publication.bundleSha256 || rederived.publishManifestBytes !== publication.publishManifestBytes) {
    throw new Error("Spool bundle fails current-main schema and allowlist revalidation.");
  }
  return publication.files.map((file) => ({ ...file, bytes: Buffer.from(file.bytes) }));
}

function validateRefreshedManifestArtifact(file: PublicationArtifact): void {
  const parsed = object(artifactJson(validateArtifact(file)), "remote refreshed publish manifest");
  const withoutHash = { ...parsed };
  delete withoutHash.manifestSha256;
  if (parsed.schemaVersion !== SHADOW_REFRESHED_PUBLISH_MANIFEST_SCHEMA_VERSION ||
      typeof parsed.manifestSha256 !== "string" || canonicalJsonSha256(withoutHash) !== parsed.manifestSha256) {
    throw new Error(`Remote refreshed manifest ${file.path} has invalid canonical identity.`);
  }
}

/**
 * Pure current-main refresh/coalescing boundary. Callers must supply bytes obtained with no-follow,
 * identity-stable reads; this function distrusts and revalidates every manifest and blob binding.
 */
export function refreshShadowPublishManifest(input: {
  readonly originIdentity: string;
  readonly trustedMainSha: string;
  readonly remoteLeaseSha: string | null;
  readonly remoteMainSha: string | null;
  readonly retainedBundles: readonly ShadowPublicationResult[];
  readonly publishedDispositionBundleSha256s: readonly string[];
  readonly remoteArtifacts: readonly PublicationArtifact[];
  readonly now: string;
}): RefreshedShadowPublication {
  if (!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(input.originIdentity)) throw new Error("originIdentity must be owner/repository.");
  const trustedMainSha = gitSha(input.trustedMainSha, "trustedMainSha");
  if (!Number.isFinite(Date.parse(input.now))) throw new Error("Refresh time must be an ISO timestamp.");
  const dispositionSet = new Set(input.publishedDispositionBundleSha256s.map((value) => sha256(value, "published disposition bundle hash")));
  if (dispositionSet.size !== input.publishedDispositionBundleSha256s.length) throw new Error("Published dispositions contain duplicate bundle hashes.");

  const bundles = new Map<string, readonly PublicationArtifact[]>();
  for (const bundle of input.retainedBundles) {
    if (bundles.has(bundle.bundleSha256)) throw new Error(`Retained spool bundle ${bundle.bundleSha256} is duplicated.`);
    bundles.set(bundle.bundleSha256, validateSealedPublicationResult(bundle));
  }
  for (const hash of dispositionSet) {
    if (!bundles.has(hash)) throw new Error(`Published disposition ${hash} has no retained exact spool bundle lineage.`);
  }
  const transition = chooseShadowPublicationTransition({
    trustedMainSha,
    remoteLeaseSha: input.remoteLeaseSha,
    remoteMainSha: input.remoteMainSha,
    retainedPublishedDispositionCount: dispositionSet.size,
  });

  const pendingHashes = [...bundles.keys()].filter((hash) => !dispositionSet.has(hash)).sort(lexical);
  const permittedRemote = new Map<string, PublicationArtifact>();
  for (const files of bundles.values()) {
    for (const file of files) {
      const prior = permittedRemote.get(file.path);
      if (prior !== undefined && sha256Bytes(prior.bytes) !== sha256Bytes(file.bytes)) {
        throw new Error(`Retained bundles collide on immutable identity ${file.path}.`);
      }
      permittedRemote.set(file.path, file);
    }
  }

  const remote = new Map<string, PublicationArtifact>();
  validatePathSet(input.remoteArtifacts.map(({ path }) => path), "remote rolling evidence");
  for (const candidate of input.remoteArtifacts) {
    const file = validateArtifact(candidate);
    const retained = permittedRemote.get(file.path);
    if (retained === undefined) {
      if (!file.path.includes("/publication-manifests/")) {
        throw new Error(`Remote rolling evidence ${file.path} lacks retained spool lineage.`);
      }
      validateRefreshedManifestArtifact(file);
    } else if (sha256Bytes(retained.bytes) !== sha256Bytes(file.bytes)) {
      throw new Error(`Remote rolling evidence ${file.path} changed immutable content.`);
    }
    remote.set(file.path, { ...file, bytes: Buffer.from(file.bytes) });
  }

  const union = new Map(remote);
  for (const hash of pendingHashes) {
    for (const file of bundles.get(hash)!) {
      const prior = union.get(file.path);
      if (prior !== undefined && sha256Bytes(prior.bytes) !== sha256Bytes(file.bytes)) {
        throw new Error(`Pending and remote evidence collide on canonical identity ${file.path}.`);
      }
      union.set(file.path, { ...file, bytes: Buffer.from(file.bytes) });
    }
  }
  const blobs = exactArtifactInventory([...union.values()]);
  const withoutHash = {
    schemaVersion: SHADOW_REFRESHED_PUBLISH_MANIFEST_SCHEMA_VERSION,
    validatorVersion: SHADOW_PUBLICATION_VALIDATOR_VERSION,
    originIdentity: input.originIdentity,
    trustedMainSha,
    branch: SHADOW_ROLLING_BRANCH,
    generatedAt: input.now,
    transition,
    inputBundleSha256s: pendingHashes,
    blobs,
    expectedOutputTreeSha256: canonicalJsonSha256(blobs),
  };
  const manifest: RefreshedShadowPublishManifest = {
    ...withoutHash,
    manifestSha256: canonicalJsonSha256(withoutHash),
  };
  const manifestPath = `${ARTIFACT_ROOT}publication-manifests/${manifest.manifestSha256}.json`;
  const manifestBytes = prettyCanonicalJson(manifest);
  const delta = [...union.values()].filter((file) => {
    const prior = remote.get(file.path);
    return prior === undefined || sha256Bytes(prior.bytes) !== sha256Bytes(file.bytes);
  });
  const status = delta.length === 0 ? "zero_delta" : "ready";
  const files = status === "zero_delta" ? [...remote.values()] : [...union.values(), {
    path: manifestPath,
    bytes: Buffer.from(manifestBytes),
    mode: "100644",
    objectType: "blob",
    linkOrReparsePoint: false,
    identityStable: true,
  } satisfies PublicationArtifact];
  return {
    status,
    manifest,
    manifestBytes,
    manifestPath,
    files: files.sort((left, right) => lexical(left.path, right.path)),
    inputBundleSha256s: pendingHashes,
    transition,
  };
}

export function evaluateCohortThreshold(input: {
  readonly observations: readonly CohortObservation[];
  readonly now: string;
}): CohortThresholdEvaluation {
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) throw new Error("Cohort evaluation time is invalid.");
  const observations = input.observations.map((observation) => ({
    observationId: sha256(observation.observationId, "cohort observationId"),
    observedAt: observation.observedAt,
    time: Date.parse(observation.observedAt),
  })).sort((left, right) => left.time - right.time || lexical(left.observationId, right.observationId));
  if (observations.some(({ time }) => !Number.isFinite(time))) throw new Error("Cohort observation time is invalid.");
  const first = observations[0];
  const countReached = observations.length >= COHORT_OBSERVATION_COUNT_GATE;
  const elapsedTimeReached = first !== undefined && nowMs - first.time >= COHORT_ELAPSED_TIME_GATE_MS;
  const trigger = countReached ? "count" as const : elapsedTimeReached ? "elapsed_time" as const : null;
  return {
    status: trigger === null ? "below_threshold" : "opened",
    trigger,
    observationIds: observations.map(({ observationId }) => observationId),
    observationCount: observations.length,
    countGate: COHORT_OBSERVATION_COUNT_GATE,
    countGateRemaining: Math.max(0, COHORT_OBSERVATION_COUNT_GATE - observations.length),
    firstObservationAt: first?.observedAt ?? null,
    timeGateAt: first === undefined
      ? null
      : new Date(first.time + COHORT_ELAPSED_TIME_GATE_MS).toISOString(),
  };
}

export function evaluateCohortCheckpoint(input: {
  readonly observations: readonly CohortObservation[];
  readonly prior: CohortCheckpoint | null;
  readonly now: string;
}): CohortCheckpointEvaluation {
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) throw new Error("Cohort evaluation time is invalid.");
  if (input.prior !== null && input.prior.resetAt === null) {
    return {
      status: input.prior.reviewedAt === null ? "already_open" : "reviewed",
      checkpoint: input.prior,
      threshold: null,
    };
  }
  const priorObservationIds = new Set(input.prior?.observationIds ?? []);
  const threshold = evaluateCohortThreshold({
    observations: input.observations.filter(({ observationId }) => !priorObservationIds.has(observationId)),
    now: input.now,
  });
  if (threshold.status === "below_threshold") return { status: "below_threshold", checkpoint: null, threshold };
  const checkpoint: CohortCheckpoint = {
    checkpointId: canonicalJsonSha256({
      firstObservationAt: threshold.firstObservationAt,
      observationIds: threshold.observationIds,
    }),
    openedAt: input.now,
    firstObservationAt: threshold.firstObservationAt!,
    observationIds: threshold.observationIds,
    reviewedAt: null,
    resetAt: null,
  };
  return { status: "opened", checkpoint, threshold };
}
