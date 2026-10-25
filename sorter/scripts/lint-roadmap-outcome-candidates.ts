import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRODUCER_KINDS,
  activeOutcomeCandidates,
  parseOutcomeEnvelope,
  outcomeSourceContentMatchesSha256,
  type OutcomeDisposition,
  type OutcomeEnvelope,
  type ProducerKind,
} from "./lib/github-issue-roadmap/outcome-candidate";
import { dispositionHistory } from "./lib/github-issue-roadmap/disposition-history";

import {
  producerFor, producerForPath, roadmapSidecarLocator, roadmapSourceLocator,
  isCanonicalSourceLocator, isRoadmapSidecarNamespace,
} from "./lib/github-issue-roadmap/producer-paths.mjs";
export { roadmapSidecarLocator } from "./lib/github-issue-roadmap/producer-paths.mjs";

export const PRODUCER_REGISTRY_SCHEMA_VERSION =
  "github-issue-roadmap-producer-registry/v1" as const;

const EXPECTED_BUDGETS = {
  maxCandidatesPerEnvelope: 5,
  maxEnvelopeBytes: 65_536,
  maxCandidateBytes: 16_384,
  maxActionPayloadBytes: 16_384,
} as const;

const ORDINAL_OUTCOME_ID = /^(?:candidate|item|outcome)[._:-]?\d+$/i;

export type ProducerPrivacyProfile = "repository_artifact" | "future_user_bug_minimal";

export interface RoadmapProducerRegistryEntry {
  readonly kind: ProducerKind;
  readonly active: boolean;
  readonly artifactGlobs: readonly string[];
  readonly completionPoint: string;
  readonly stableArtifactIdentity: string;
  readonly stableOutcomeIdentity: string;
  readonly sidecar: {
    readonly storageRoot: "artifacts/github-issue-roadmap";
    readonly naming: "percent_encode_source_locator";
    readonly prefix: "outcome-candidate--";
    readonly suffix: ".roadmap-outcomes.json";
  };
  readonly envelopeWriter: string;
  readonly failureBehavior: "fail_completion_handoff" | "inactive_until_surface_exists";
  readonly budgets: typeof EXPECTED_BUDGETS;
  readonly privacyProfile: ProducerPrivacyProfile;
  readonly conformanceFixture: string;
}

export interface AuthorizedIdentityMapping {
  readonly stableArtifactId: string;
  readonly fromLocator: string;
  readonly toLocator: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly reason: string;
}

export interface RoadmapProducerRegistry {
  readonly schemaVersion: typeof PRODUCER_REGISTRY_SCHEMA_VERSION;
  readonly cutover:
    | { readonly status: "pending"; readonly effectiveAt: null }
    | { readonly status: "effective"; readonly effectiveAt: string };
  readonly recallSoak: {
    readonly status: "pending" | "passed";
    readonly requiredArtifactCount: 20;
    readonly reviewedArtifactCount: number;
    readonly missedCloseableOutcomeCount: number | null;
    readonly evidenceLocator: string | null;
  };
  readonly authorizedIdentityMappings: readonly AuthorizedIdentityMapping[];
  readonly producers: readonly RoadmapProducerRegistryEntry[];
}

type JsonObject = Record<string, unknown>;

function object(value: unknown, context: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, expected: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${context} must contain exact keys [${wanted.join(", ")}].`);
  }
}

function string(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${context} must be a non-empty string.`);
  }
  return value;
}

function isoTimestamp(value: unknown, context: string): string {
  const timestamp = string(value, context);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    throw new Error(`${context} must be an ISO-8601 timestamp.`);
  }
  return timestamp;
}

function strings(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must be a non-empty array.`);
  }
  return value.map((entry, index) => string(entry, `${context}[${index}]`));
}

function parseBudgets(value: unknown, context: string): typeof EXPECTED_BUDGETS {
  const raw = object(value, context);
  exactKeys(raw, Object.keys(EXPECTED_BUDGETS), context);
  for (const [name, expected] of Object.entries(EXPECTED_BUDGETS)) {
    if (raw[name] !== expected) {
      throw new Error(`${context}.${name} must equal ${expected}.`);
    }
  }
  return EXPECTED_BUDGETS;
}

function parseProducer(value: unknown, index: number): RoadmapProducerRegistryEntry {
  const context = `producer registry.producers[${index}]`;
  const raw = object(value, context);
  exactKeys(raw, [
    "kind", "active", "artifactGlobs", "completionPoint", "stableArtifactIdentity",
    "stableOutcomeIdentity", "sidecar", "envelopeWriter", "failureBehavior", "budgets",
    "privacyProfile", "conformanceFixture",
  ], context);
  if (!PRODUCER_KINDS.includes(raw.kind as ProducerKind)) {
    throw new Error(`${context}.kind is outside the closed producer kind contract.`);
  }
  if (typeof raw.active !== "boolean") throw new Error(`${context}.active must be boolean.`);
  const sidecar = object(raw.sidecar, `${context}.sidecar`);
  exactKeys(sidecar, ["storageRoot", "naming", "prefix", "suffix"], `${context}.sidecar`);
  if (
    sidecar.storageRoot !== "artifacts/github-issue-roadmap" ||
    sidecar.naming !== "percent_encode_source_locator" ||
    sidecar.prefix !== "outcome-candidate--" ||
    sidecar.suffix !== ".roadmap-outcomes.json"
  ) {
    throw new Error(`${context}.sidecar must use the canonical confined mirror path and appended suffix.`);
  }
  const privacyProfile = string(raw.privacyProfile, `${context}.privacyProfile`);
  if (privacyProfile !== "repository_artifact" && privacyProfile !== "future_user_bug_minimal") {
    throw new Error(`${context}.privacyProfile is unsupported.`);
  }
  if (raw.kind === "future_user_bug" && privacyProfile !== "future_user_bug_minimal") {
    throw new Error(`${context} must use the future user bug privacy profile.`);
  }
  const failureBehavior = string(raw.failureBehavior, `${context}.failureBehavior`);
  if (failureBehavior !== "fail_completion_handoff" && failureBehavior !== "inactive_until_surface_exists") {
    throw new Error(`${context}.failureBehavior is unsupported.`);
  }
  if (raw.kind === "future_user_bug" && raw.active) {
    throw new Error(`${context} must remain inactive until the user bug surface exists.`);
  }
  return {
    kind: raw.kind as ProducerKind,
    active: raw.active,
    artifactGlobs: strings(raw.artifactGlobs, `${context}.artifactGlobs`),
    completionPoint: string(raw.completionPoint, `${context}.completionPoint`),
    stableArtifactIdentity: string(raw.stableArtifactIdentity, `${context}.stableArtifactIdentity`),
    stableOutcomeIdentity: string(raw.stableOutcomeIdentity, `${context}.stableOutcomeIdentity`),
    sidecar: {
      storageRoot: "artifacts/github-issue-roadmap",
      naming: "percent_encode_source_locator",
      prefix: "outcome-candidate--",
      suffix: ".roadmap-outcomes.json",
    },
    envelopeWriter: string(raw.envelopeWriter, `${context}.envelopeWriter`),
    failureBehavior: failureBehavior as RoadmapProducerRegistryEntry["failureBehavior"],
    budgets: parseBudgets(raw.budgets, `${context}.budgets`),
    privacyProfile,
    conformanceFixture: string(raw.conformanceFixture, `${context}.conformanceFixture`),
  };
}

function parseIdentityMapping(value: unknown, index: number): AuthorizedIdentityMapping {
  const context = `producer registry.authorizedIdentityMappings[${index}]`;
  const raw = object(value, context);
  exactKeys(raw, [
    "stableArtifactId", "fromLocator", "toLocator", "approvedBy", "approvedAt", "reason",
  ], context);
  return {
    stableArtifactId: string(raw.stableArtifactId, `${context}.stableArtifactId`),
    fromLocator: string(raw.fromLocator, `${context}.fromLocator`),
    toLocator: string(raw.toLocator, `${context}.toLocator`),
    approvedBy: string(raw.approvedBy, `${context}.approvedBy`),
    approvedAt: isoTimestamp(raw.approvedAt, `${context}.approvedAt`),
    reason: string(raw.reason, `${context}.reason`),
  };
}

export function parseRoadmapProducerRegistry(value: unknown): RoadmapProducerRegistry {
  const raw = object(value, "producer registry");
  exactKeys(raw, [
    "schemaVersion", "cutover", "recallSoak", "authorizedIdentityMappings", "producers",
  ], "producer registry");
  if (raw.schemaVersion !== PRODUCER_REGISTRY_SCHEMA_VERSION) {
    throw new Error(`producer registry.schemaVersion must be ${PRODUCER_REGISTRY_SCHEMA_VERSION}.`);
  }
  const cutoverRaw = object(raw.cutover, "producer registry.cutover");
  exactKeys(cutoverRaw, ["status", "effectiveAt"], "producer registry.cutover");
  if (cutoverRaw.status !== "pending" && cutoverRaw.status !== "effective") {
    throw new Error("producer registry.cutover.status is unsupported.");
  }
  const cutover: RoadmapProducerRegistry["cutover"] = cutoverRaw.status === "pending"
    ? (() => {
      if (cutoverRaw.effectiveAt !== null) {
        throw new Error("A pending producer cutover cannot claim an effective timestamp.");
      }
      return { status: "pending", effectiveAt: null };
    })()
    : {
      status: "effective",
      effectiveAt: isoTimestamp(cutoverRaw.effectiveAt, "producer registry.cutover.effectiveAt"),
    };

  const soakRaw = object(raw.recallSoak, "producer registry.recallSoak");
  exactKeys(soakRaw, [
    "status", "requiredArtifactCount", "reviewedArtifactCount",
    "missedCloseableOutcomeCount", "evidenceLocator",
  ], "producer registry.recallSoak");
  if (soakRaw.status !== "pending" && soakRaw.status !== "passed") {
    throw new Error("producer registry.recallSoak.status is unsupported.");
  }
  if (soakRaw.requiredArtifactCount !== 20) {
    throw new Error("producer registry.recallSoak.requiredArtifactCount must equal 20.");
  }
  if (!Number.isSafeInteger(soakRaw.reviewedArtifactCount) || (soakRaw.reviewedArtifactCount as number) < 0) {
    throw new Error("producer registry.recallSoak.reviewedArtifactCount must be a non-negative integer.");
  }
  if (
    soakRaw.missedCloseableOutcomeCount !== null &&
    (!Number.isSafeInteger(soakRaw.missedCloseableOutcomeCount) ||
      (soakRaw.missedCloseableOutcomeCount as number) < 0)
  ) {
    throw new Error("producer registry.recallSoak.missedCloseableOutcomeCount is invalid.");
  }
  if (soakRaw.evidenceLocator !== null && typeof soakRaw.evidenceLocator !== "string") {
    throw new Error("producer registry.recallSoak.evidenceLocator must be a string or null.");
  }
  if (soakRaw.status === "passed" && (
    (soakRaw.reviewedArtifactCount as number) < 20 ||
    soakRaw.missedCloseableOutcomeCount !== 0 ||
    typeof soakRaw.evidenceLocator !== "string" || soakRaw.evidenceLocator.trim() === ""
  )) {
    throw new Error("A passed recall soak requires 20 reviewed artifacts, zero misses, and evidence.");
  }

  if (!Array.isArray(raw.producers)) throw new Error("producer registry.producers must be an array.");
  const producers = raw.producers.map(parseProducer);
  const kinds = producers.map(({ kind }) => kind);
  if (
    kinds.length !== PRODUCER_KINDS.length ||
    new Set(kinds).size !== kinds.length ||
    PRODUCER_KINDS.some((kind) => !kinds.includes(kind))
  ) {
    throw new Error("producer registry.producers must contain every closed producer kind exactly once.");
  }
  producers.sort((left, right) => PRODUCER_KINDS.indexOf(left.kind) - PRODUCER_KINDS.indexOf(right.kind));

  if (!Array.isArray(raw.authorizedIdentityMappings)) {
    throw new Error("producer registry.authorizedIdentityMappings must be an array.");
  }
  const authorizedIdentityMappings = raw.authorizedIdentityMappings.map(parseIdentityMapping);
  const mappingKeys = authorizedIdentityMappings.map((mapping) =>
    `${mapping.stableArtifactId}\0${mapping.fromLocator}\0${mapping.toLocator}`);
  if (new Set(mappingKeys).size !== mappingKeys.length) {
    throw new Error("producer registry.authorizedIdentityMappings contains duplicates.");
  }

  return {
    schemaVersion: PRODUCER_REGISTRY_SCHEMA_VERSION,
    cutover,
    recallSoak: {
      status: soakRaw.status,
      requiredArtifactCount: 20,
      reviewedArtifactCount: soakRaw.reviewedArtifactCount as number,
      missedCloseableOutcomeCount: soakRaw.missedCloseableOutcomeCount as number | null,
      evidenceLocator: soakRaw.evidenceLocator as string | null,
    },
    authorizedIdentityMappings,
    producers,
  };
}

export interface RoadmapArtifactInput {
  readonly sourceLocator: string;
  readonly completedAt: string | null;
  readonly sidecar: unknown | null;
}

export interface PriorArtifactIdentity {
  readonly stableArtifactId: string;
  readonly sourceLocator: string;
}

interface PriorArtifactSnapshot extends PriorArtifactIdentity {
  readonly dispositions: ReadonlyMap<string, OutcomeDisposition>;
  readonly envelope: OutcomeEnvelope;
}

export type RoadmapArtifactStatus =
  | "explicit_empty"
  | "valid_candidates"
  | "invalid_sidecar"
  | "missing_post_cutover"
  | "historical_without_sidecar"
  | "pending_cutover_without_sidecar";

export interface RoadmapProducerViolation {
  readonly code:
    | "unregistered_artifact"
    | "missing_post_cutover_sidecar"
    | "invalid_sidecar"
    | "producer_kind_mismatch"
    | "source_locator_mismatch"
    | "envelope_budget_exceeded"
    | "candidate_budget_exceeded"
    | "candidate_count_exceeded"
    | "ordinal_outcome_identity"
    | "duplicate_artifact_identity"
    | "unauthorized_identity_move"
    | "artifact_identity_replaced"
    | "invalid_identity_move"
    | "stale_source_revision"
    | "stale_source_evidence"
    | "orphan_sidecar"
    | "invalid_sidecar_path"
    | "non_regular_artifact"
    | "disposition_evidence_not_on_main"
    | "disposition_evidence_unresolvable"
    | "disposition_removed"
    | "disposition_changed"
    | "supersession_target_unresolved"
    | "supersession_self_reference"
    | "supersession_cycle";
  readonly sourceLocator: string;
  readonly detail: string;
}

export interface RoadmapProducerLintResult {
  readonly artifacts: readonly {
    readonly sourceLocator: string;
    readonly producerKind: ProducerKind | null;
    readonly status: RoadmapArtifactStatus;
    readonly candidateCount: number | null;
    readonly envelope: OutcomeEnvelope | null;
  }[];
  readonly violations: readonly RoadmapProducerViolation[];
  readonly productionEnablement: {
    readonly allowed: boolean;
    readonly blockers: readonly string[];
  };
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isPostCutover(
  completedAt: string | null,
  cutover: RoadmapProducerRegistry["cutover"],
): boolean {
  if (cutover.status !== "effective") return false;
  if (completedAt === null) return true;
  const completionTime = Date.parse(completedAt);
  if (Number.isNaN(completionTime)) return true;
  return completionTime >= Date.parse(cutover.effectiveAt);
}

export function lintRoadmapOutcomeCandidates(input: {
  readonly registry: RoadmapProducerRegistry;
  readonly artifacts: readonly RoadmapArtifactInput[];
  readonly previousArtifactIdentities?: readonly PriorArtifactIdentity[];
}): RoadmapProducerLintResult {
  const registry = parseRoadmapProducerRegistry(input.registry);
  const violations: RoadmapProducerViolation[] = [];
  const artifacts: Array<RoadmapProducerLintResult["artifacts"][number]> = [];
  const identities = new Map<string, string[]>();

  for (const artifact of [...input.artifacts].sort((left, right) =>
    left.sourceLocator.localeCompare(right.sourceLocator, "en"))) {
    const producer = producerFor(artifact.sourceLocator, registry.producers);
    if (producer === null) {
      violations.push({
        code: "unregistered_artifact",
        sourceLocator: artifact.sourceLocator,
        detail: "Artifact does not match exactly one active producer registry entry.",
      });
      artifacts.push({
        sourceLocator: artifact.sourceLocator,
        producerKind: null,
        status: "invalid_sidecar",
        candidateCount: null,
        envelope: null,
      });
      continue;
    }
    const postCutover = isPostCutover(artifact.completedAt, registry.cutover);
    if (artifact.sidecar === null) {
      const status: RoadmapArtifactStatus = registry.cutover.status === "pending"
        ? "pending_cutover_without_sidecar"
        : postCutover ? "missing_post_cutover" : "historical_without_sidecar";
      if (status === "missing_post_cutover") {
        violations.push({
          code: "missing_post_cutover_sidecar",
          sourceLocator: artifact.sourceLocator,
          detail: `Post-cutover artifact is missing ${roadmapSidecarLocator(producer, artifact.sourceLocator)}.`,
        });
      }
      artifacts.push({
        sourceLocator: artifact.sourceLocator,
        producerKind: producer.kind,
        status,
        candidateCount: null,
        envelope: null,
      });
      continue;
    }

    try {
      const envelope = parseOutcomeEnvelope(artifact.sidecar);
      const artifactViolationsBefore = violations.length;
      if (envelope.producer.kind !== producer.kind) {
        violations.push({
          code: "producer_kind_mismatch",
          sourceLocator: artifact.sourceLocator,
          detail: `Sidecar producer is ${envelope.producer.kind}, expected ${producer.kind}.`,
        });
      }
      if (envelope.artifact.sourceLocator !== artifact.sourceLocator) {
        violations.push({
          code: "source_locator_mismatch",
          sourceLocator: artifact.sourceLocator,
          detail: "Sidecar sourceLocator must equal the registered artifact path.",
        });
      }
      if (activeOutcomeCandidates(envelope).active.length > producer.budgets.maxCandidatesPerEnvelope) {
        violations.push({
          code: "candidate_count_exceeded",
          sourceLocator: artifact.sourceLocator,
          detail: `Sidecar exceeds the ${producer.budgets.maxCandidatesPerEnvelope}-candidate budget.`,
        });
      }
      if (bytes(artifact.sidecar) > producer.budgets.maxEnvelopeBytes) {
        violations.push({
          code: "envelope_budget_exceeded",
          sourceLocator: artifact.sourceLocator,
          detail: `Sidecar exceeds the ${producer.budgets.maxEnvelopeBytes}-byte envelope budget.`,
        });
      }
      for (const candidate of envelope.candidates) {
        if (bytes(candidate) > producer.budgets.maxCandidateBytes) {
          violations.push({
            code: "candidate_budget_exceeded",
            sourceLocator: artifact.sourceLocator,
            detail: `${candidate.stableOutcomeId} exceeds the ${producer.budgets.maxCandidateBytes}-byte candidate budget.`,
          });
        }
        if (ORDINAL_OUTCOME_ID.test(candidate.stableOutcomeId)) {
          violations.push({
            code: "ordinal_outcome_identity",
            sourceLocator: artifact.sourceLocator,
            detail: `${candidate.stableOutcomeId} is positional; stable outcome identities must describe the outcome.`,
          });
        }
      }
      const identityLocators = identities.get(envelope.artifact.stableId) ?? [];
      identityLocators.push(artifact.sourceLocator);
      identities.set(envelope.artifact.stableId, identityLocators);
      const status: RoadmapArtifactStatus = violations.length === artifactViolationsBefore
        ? envelope.candidates.length === 0 ? "explicit_empty" : "valid_candidates"
        : "invalid_sidecar";
      artifacts.push({
        sourceLocator: artifact.sourceLocator,
        producerKind: producer.kind,
        status,
        candidateCount: envelope.candidates.length,
        envelope: status === "invalid_sidecar" ? null : envelope,
      });
    } catch (error) {
      violations.push({
        code: "invalid_sidecar",
        sourceLocator: artifact.sourceLocator,
        detail: error instanceof Error ? error.message : String(error),
      });
      artifacts.push({
        sourceLocator: artifact.sourceLocator,
        producerKind: producer.kind,
        status: "invalid_sidecar",
        candidateCount: null,
        envelope: null,
      });
    }
  }

  for (const [stableArtifactId, locators] of identities) {
    if (locators.length <= 1) continue;
    violations.push({
      code: "duplicate_artifact_identity",
      sourceLocator: [...locators].sort()[0],
      detail: `${stableArtifactId} is reused by copied artifacts: ${[...locators].sort().join(", ")}.`,
    });
  }

  for (const previous of input.previousArtifactIdentities ?? []) {
    const current = identities.get(previous.stableArtifactId);
    if (current === undefined || current.length !== 1 || current[0] === previous.sourceLocator) continue;
    const authorized = registry.authorizedIdentityMappings.some((mapping) =>
      mapping.stableArtifactId === previous.stableArtifactId &&
      mapping.fromLocator === previous.sourceLocator &&
      mapping.toLocator === current[0]);
    if (!authorized) {
      violations.push({
        code: "unauthorized_identity_move",
        sourceLocator: current[0],
        detail: `${previous.stableArtifactId} moved from ${previous.sourceLocator} without an authorized mapping.`,
      });
    }
  }

  const blockers: string[] = [];
  if (registry.cutover.status !== "effective") blockers.push("producer_cutover_pending");
  if (registry.recallSoak.status !== "passed") blockers.push("first_20_artifact_recall_soak_pending");
  if (violations.length > 0) blockers.push("producer_conformance_violations");
  return {
    artifacts,
    violations,
    productionEnablement: { allowed: blockers.length === 0, blockers },
  };
}

const PRUNED_SCAN_DIRECTORIES = new Set([
  ".git", ".next", ".turbo", ".worktrees", "coverage", "dist", "node_modules", "out",
]);

function walkFiles(root: string, current: string): string[] {
  if (!existsSync(current)) return [];
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && PRUNED_SCAN_DIRECTORIES.has(entry.name)) return [];
    const path = resolve(current, entry.name);
    return entry.isDirectory() ? walkFiles(root, path) : [relative(root, path).replaceAll("\\", "/")];
  });
}

function staticGlobRoot(glob: string): string {
  const firstPattern = glob.search(/[*{]/);
  const stablePrefix = firstPattern === -1 ? glob : glob.slice(0, firstPattern);
  return stablePrefix.endsWith("/")
    ? stablePrefix.slice(0, -1)
    : stablePrefix.slice(0, Math.max(stablePrefix.lastIndexOf("/"), 0));
}

function nulSeparatedPaths(raw: string): string[] {
  return raw.split("\0").filter(Boolean);
}

function artifactGitMetadata(
  repoRoot: string,
  sourceLocators: readonly string[],
  scanRoots: readonly string[],
  revision = "HEAD",
): { readonly dirty: ReadonlySet<string>; readonly latestCommittedAt: ReadonlyMap<string, string> } {
  try {
    const git = (args: readonly string[]) => execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const dirty = new Set([
      ...nulSeparatedPaths(git(["diff", "--name-only", "-z", "HEAD", "--", ...scanRoots])),
      ...nulSeparatedPaths(git(["ls-files", "--others", "--exclude-standard", "-z", "--", ...scanRoots])),
    ]);
    const latestCommittedAt = new Map<string, string>();
    let commitTimestamp: string | null = null;
    const history = git([
      "-c", "core.quotePath=false", "log", "--format=%x1e%aI", "--name-only",
      "--no-renames", revision, "--", ...scanRoots,
    ]);
    for (const line of history.split(/\r?\n/)) {
      if (line.startsWith("\x1e")) {
        commitTimestamp = line.slice(1).trim();
      } else if (commitTimestamp !== null && line !== "") {
        const path = line.replaceAll("\\", "/");
        if (!latestCommittedAt.has(path)) latestCommittedAt.set(path, commitTimestamp);
      }
    }
    return { dirty, latestCommittedAt };
  } catch {
    return { dirty: new Set(sourceLocators), latestCommittedAt: new Map() };
  }
}

export function discoverRoadmapProducerArtifacts(
  repoRoot: string,
  registry: RoadmapProducerRegistry,
): RoadmapArtifactInput[] {
  const activeProducers = registry.producers.filter(({ active }) => active);
  const scanRoots = new Set(activeProducers.flatMap(({ artifactGlobs }) =>
    artifactGlobs.map(staticGlobRoot)));
  const files = [...new Set([...scanRoots].flatMap((scanRoot) =>
    walkFiles(repoRoot, resolve(repoRoot, scanRoot))))];
  const gitMetadata = registry.cutover.status === "effective"
    ? artifactGitMetadata(repoRoot, files, [...scanRoots])
    : null;
  return files.flatMap((sourceLocator): RoadmapArtifactInput[] => {
    const producer = producerFor(sourceLocator, activeProducers);
    if (producer === null) return [];
    const sidecarPath = resolve(repoRoot, roadmapSidecarLocator(producer, sourceLocator));
    let sidecar: unknown | null = null;
    if (existsSync(sidecarPath) && lstatSync(sidecarPath).isFile()) {
      sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
    }
    return [{
      sourceLocator,
      completedAt: registry.cutover.status === "pending"
        ? null
        : gitMetadata?.dirty.has(sourceLocator)
          ? null
          : gitMetadata?.latestCommittedAt.get(sourceLocator) ?? null,
      sidecar,
    }];
  });
}

export interface RoadmapDiffContext {
  readonly event: "push" | "pull_request" | "merge_group";
  readonly base: string;
  readonly head: string;
}

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  });
}

function eventBoundary(repoRoot: string, context?: RoadmapDiffContext) {
  try {
    if (git(repoRoot, ["rev-parse", "--is-shallow-repository"]).trim() !== "false") {
      throw new Error("Full Git history is required; fetch the missing history before linting dispositions.");
    }
    const revision = (ref: string) => {
      if (!ref || ref.startsWith("-") || /[\s\0]/.test(ref)) throw new Error("Invalid revision.");
      return git(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
    };
    if (context) {
      if (context.event !== "push" && context.event !== "pull_request" && context.event !== "merge_group") throw new Error("Unsupported event.");
      const head = revision(context.head);
      const base = revision(context.base);
      return { head, eventBase: base, base: context.event === "pull_request"
        ? revision(git(repoRoot, ["merge-base", base, head]).trim()) : base };
    }
    const head = revision("HEAD");
    const eventBase = revision("origin/main");
    return { head, eventBase, base: revision(git(repoRoot, ["merge-base", head, eventBase]).trim()) };
  } catch (error) {
    throw new Error(`disposition_evidence_unresolvable: Cannot establish roadmap event revision history boundary: ${error instanceof Error ? error.message : error}`);
  }
}

type TreeEntry = { readonly mode: string; readonly oid: string };
type GitTree = ReadonlyMap<string, TreeEntry>;

function gitTree(repoRoot: string, revision: string): GitTree {
  return new Map(git(repoRoot, ["ls-tree", "-r", "-z", revision]).split("\0").filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t");
    const [mode, , oid] = entry.slice(0, tab).split(" ");
    return [entry.slice(tab + 1), { mode, oid }];
  }));
}

function regularMode(entry: TreeEntry | undefined): boolean {
  return entry?.mode === "100644" || entry?.mode === "100755";
}

/** One batch process per snapshot, rather than a Git process per historical sidecar. */
function readTreeFiles(repoRoot: string, tree: GitTree, paths: readonly string[]): Map<string, Buffer> {
  const selected = paths.filter((path) => regularMode(tree.get(path)));
  if (selected.length === 0) return new Map();
  const raw = execFileSync("git", ["cat-file", "--batch"], {
    cwd: repoRoot, input: selected.map((path) => tree.get(path)!.oid).join("\n") + "\n",
    stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  });
  let offset = 0;
  return new Map(selected.map((path) => {
    const end = raw.indexOf(10, offset);
    const header = raw.subarray(offset, end).toString("ascii").split(" ");
    const size = Number(header[2]);
    if (end < 0 || header[1] !== "blob" || !Number.isSafeInteger(size) || size < 0 || end + size + 1 >= raw.length) {
      throw new Error(`Cannot read Git history bytes for ${path}.`);
    }
    const content = raw.subarray(end + 1, end + 1 + size);
    offset = end + size + 2;
    return [path, content];
  }));
}

function identitiesAt(repoRoot: string, tree: GitTree, registry: RoadmapProducerRegistry): PriorArtifactSnapshot[] {
  const paths = [...tree.keys()].filter(isRoadmapSidecarNamespace);
  const contents = readTreeFiles(repoRoot, tree, paths);
  return paths.map((path) => {
    const source = roadmapSourceLocator(path);
    if (!source || !producerFor(source, registry.producers) || !regularMode(tree.get(path)) || !regularMode(tree.get(source))) {
      throw new Error(`Invalid historical source-sidecar pair ${path}; repair its canonical regular source and sidecar.`);
    }
    try {
      const envelope = parseOutcomeEnvelope(JSON.parse(contents.get(path)!.toString("utf8")));
      if (envelope.artifact.sourceLocator !== source) throw new Error("Source locator disagrees with its canonical sidecar name.");
      return {
        stableArtifactId: envelope.artifact.stableId,
        sourceLocator: source,
        envelope,
        dispositions: new Map(activeOutcomeCandidates(envelope).dispositioned.map((candidate) =>
          [candidate.stableOutcomeId, candidate.disposition!])),
      };
    } catch (error) {
      throw new Error(`Cannot establish prior artifact identity from ${path}: ${
        error instanceof Error ? error.message : error
      } Repair requires an explicit identity-history recovery policy; do not replace or discard the prior identity.`);
    }
  });
}

export function previousRoadmapArtifactIdentities(
  repoRoot: string,
  registry: RoadmapProducerRegistry,
): PriorArtifactIdentity[] {
  if (registry.cutover.status === "pending") return [];
  const boundary = eventBoundary(repoRoot);
  return identitiesAt(repoRoot, gitTree(repoRoot, boundary.base), registry)
    .map(({ stableArtifactId, sourceLocator }) => ({ stableArtifactId, sourceLocator }));
}

/** Dispositions are terminal by outcome id, even after paired deletion or an artifact change. */
function lintDispositionTransition(
  repoRoot: string,
  eventBase: string,
  previous: readonly PriorArtifactSnapshot[],
  current: ReadonlyMap<string, OutcomeEnvelope>,
  currentPaths: ReadonlySet<string>,
  registry: RoadmapProducerRegistry,
  committedHead: ReadonlyMap<string, OutcomeEnvelope> = current,
): RoadmapProducerViolation[] {
  const history = dispositionHistory(eventBase, { repoRoot });
  const violations: RoadmapProducerViolation[] = [];
  const violation = (code: RoadmapProducerViolation["code"], sourceLocator: string, detail: string) =>
    violations.push({ code, sourceLocator, detail });
  const identity = (artifactId: string, outcomeId: string) => `${artifactId}\0${outcomeId}`;
  const committedTargets = new Map<string, number>();
  for (const envelope of committedHead.values()) {
    for (const candidate of envelope.candidates) {
      const key = identity(envelope.artifact.stableId, candidate.stableOutcomeId);
      committedTargets.set(key, (committedTargets.get(key) ?? 0) + 1);
    }
  }
  type HeadCandidate = { sourceLocator: string; stableArtifactId: string; candidate: OutcomeEnvelope["candidates"][number] };
  const currentArtifactIds = new Set<string>();
  const graph = new Map<string, HeadCandidate[]>();
  for (const [sourceLocator, envelope] of current) {
    currentArtifactIds.add(envelope.artifact.stableId);
    for (const candidate of envelope.candidates) {
      const key = identity(envelope.artifact.stableId, candidate.stableOutcomeId);
      const entries = graph.get(key) ?? [];
      entries.push({ sourceLocator, stableArtifactId: envelope.artifact.stableId, candidate });
      graph.set(key, entries);
    }
  }

  for (const prior of previous) {
    const producer = producerFor(prior.sourceLocator, registry.producers)!;
    const pairedDeletion = !currentPaths.has(prior.sourceLocator)
      && !currentPaths.has(roadmapSidecarLocator(producer, prior.sourceLocator));
    if (pairedDeletion && !currentArtifactIds.has(prior.stableArtifactId)) continue;
    for (const outcomeId of prior.dispositions.keys()) {
      if (!graph.has(identity(prior.stableArtifactId, outcomeId))) {
        violation("disposition_removed", prior.sourceLocator, `Restore dispositioned candidate ${prior.stableArtifactId}/${outcomeId}, or delete its source and sidecar together.`);
      }
    }
  }

  for (const entries of graph.values()) {
    for (const { sourceLocator, stableArtifactId, candidate } of entries) {
      const { stableOutcomeId, disposition } = candidate;
      const frozen = history.get(stableOutcomeId);
      if (frozen?.length) {
        if (disposition === undefined) {
          violation("disposition_removed", sourceLocator, `Restore the frozen disposition for ${stableOutcomeId}; a reversal requires a new outcome id.`);
        } else if (frozen.some((entry) => JSON.stringify(entry.disposition) !== JSON.stringify(disposition))) {
          violation("disposition_changed", sourceLocator, `Preserve the byte-identical disposition for ${stableOutcomeId}; a reversal requires a new outcome id.`);
        }
      }
      const unchangedFrozen = frozen?.length && frozen.every((entry) =>
        entry.stableArtifactId === stableArtifactId
        && JSON.stringify(entry.disposition) === JSON.stringify(disposition));
      if (disposition?.kind === "achieved" && !unchangedFrozen) {
        for (const { sha } of disposition.commits) {
          try {
            if (git(repoRoot, ["cat-file", "-t", sha]).trim() !== "commit") throw new Error("Evidence must resolve to a commit.");
          } catch (error) {
            violation("disposition_evidence_unresolvable", sourceLocator, `Cannot resolve ${stableOutcomeId} evidence ${sha}: ${error instanceof Error ? error.message : error}`);
            continue;
          }
          try {
            git(repoRoot, ["merge-base", "--is-ancestor", sha, eventBase]);
          } catch (error) {
            const code = (error as { status?: number }).status === 1
              ? "disposition_evidence_not_on_main" : "disposition_evidence_unresolvable";
            violation(code, sourceLocator, `${stableOutcomeId} evidence ${sha} must be an ancestor of event base ${eventBase}.`);
          }
        }
      }
      // A frozen supersession may outlive its target. Only its introducing transition resolves it.
      if (disposition?.kind !== "superseded" || frozen?.length) continue;
      const key = identity(stableArtifactId, stableOutcomeId);
      const target = identity(disposition.target.stableArtifactId, disposition.target.stableOutcomeId);
      if (key === target) {
        violation("supersession_self_reference", sourceLocator, `${stableOutcomeId} cannot supersede itself.`);
        continue;
      }
      if (committedTargets.get(target) !== 1 || graph.get(target)?.length !== 1) {
        violation("supersession_target_unresolved", sourceLocator, `${stableOutcomeId} target must resolve to exactly one candidate at head.`);
        continue;
      }
      const visited = new Set([key]);
      let next: string | undefined = target;
      while (next !== undefined) {
        if (visited.has(next)) {
          violation("supersession_cycle", sourceLocator, `${stableOutcomeId} introduces a cycle in the head supersession graph.`);
          break;
        }
        visited.add(next);
        const targets = graph.get(next);
        const following = targets?.length === 1 ? targets[0].candidate.disposition : undefined;
        next = following?.kind === "superseded"
          ? identity(following.target.stableArtifactId, following.target.stableOutcomeId) : undefined;
      }
    }
  }
  return violations;
}

/** Refuse symlinked ancestors as well as symlink or non-file endpoints. */
function regularWorktreeFile(repoRoot: string, path: string): boolean {
  const segments = path.split("/");
  let current = repoRoot;
  return segments.every((part, index) => {
    current = resolve(current, part);
    try {
      const stat = lstatSync(current);
      return index === segments.length - 1 ? stat.isFile() : stat.isDirectory() && !stat.isSymbolicLink();
    } catch { return false; }
  });
}

export function lintRoadmapRepositoryTransition(
  repoRoot: string,
  registry: RoadmapProducerRegistry,
  context?: RoadmapDiffContext,
): RoadmapProducerLintResult {
  const boundary = eventBoundary(repoRoot, context);
  const baseTree = gitTree(repoRoot, boundary.base);
  const headTree = gitTree(repoRoot, boundary.head);
  const changed = new Set(nulSeparatedPaths(git(repoRoot, [
    "diff", "--no-renames", "--name-only", "-z", boundary.base, boundary.head, "--",
  ])));
  let paths = [...headTree.keys()];
  if (!context) {
    for (const path of nulSeparatedPaths(git(repoRoot, ["diff", "--no-renames", "--name-only", "-z", "HEAD", "--"]))) changed.add(path);
    const untracked = nulSeparatedPaths(git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]));
    untracked.forEach((path) => changed.add(path));
    paths = [...new Set([...paths, ...changed])].filter((path) => {
      try { lstatSync(resolve(repoRoot, path)); return true; } catch { return false; }
    });
  }
  const active = registry.producers.filter(({ active }) => active);
  const affected = new Set<string>();
  const violations: RoadmapProducerViolation[] = [];
  const violation = (code: RoadmapProducerViolation["code"], sourceLocator: string, detail: string) =>
    violations.push({ code, sourceLocator, detail });
  const currentPaths = new Set(paths);
  for (const path of changed) {
    const registeredProducer = producerForPath(path, active);
    if (registeredProducer && isCanonicalSourceLocator(path)) affected.add(path);
    else if (registeredProducer && currentPaths.has(path)) {
      violation(
        "unregistered_artifact",
        path,
        "Rename this registered document to a canonical source locator of at most 512 characters using only ASCII letters, digits, and ._@+/- before generating its sidecar.",
      );
    }
    if (isRoadmapSidecarNamespace(path)) {
      const source = roadmapSourceLocator(path);
      if (!source || !producerFor(source, active)) {
        violation("invalid_sidecar_path", path, "Use the exact canonical percent-encoded name for one registered source.");
      } else affected.add(source);
    }
  }
  const sidecars = paths.filter(isRoadmapSidecarNamespace);
  const sourcePaths = paths.filter((path) => producerFor(path, active));
  const regular = (path: string) => context ? regularMode(headTree.get(path)) : regularWorktreeFile(repoRoot, path);
  const contents = context ? readTreeFiles(repoRoot, headTree, [...sidecars, ...affected]) : null;
  const read = (path: string) => contents ? contents.get(path)! : readFileSync(resolve(repoRoot, path));
  for (const path of sidecars) {
    const source = roadmapSourceLocator(path);
    if (!source || !producerFor(source, active)) {
      violation("invalid_sidecar_path", path, "Use the canonical sidecar name for one registered source.");
    } else if (!currentPaths.has(source)) {
      violation("orphan_sidecar", path, `Restore ${source} or delete its sidecar together with the source.`);
    }
  }
  const scanRoots = [...new Set(active.flatMap(({ artifactGlobs }) => artifactGlobs.map(staticGlobRoot)))];
  const metadata = artifactGitMetadata(repoRoot, sourcePaths, scanRoots, boundary.head);
  const artifacts: RoadmapArtifactInput[] = sourcePaths.map((sourceLocator) => {
    const producer = producerFor(sourceLocator, active)!;
    const path = roadmapSidecarLocator(producer, sourceLocator);
    let sidecar: unknown | null = null;
    if (!regular(sourceLocator)) violation("non_regular_artifact", sourceLocator, "Replace the source with a regular file; symlinks are not eligible.");
    if (currentPaths.has(path)) {
      if (!regular(path)) violation("non_regular_artifact", path, "Replace the sidecar with a regular file; symlinks are not eligible.");
      else {
        try { sidecar = JSON.parse(read(path).toString("utf8")); }
        catch (error) { violation("invalid_sidecar", path, `Repair malformed sidecar JSON: ${error instanceof Error ? error.message : error}`); }
      }
    }
    return { sourceLocator, sidecar, completedAt: affected.has(sourceLocator) ? null : metadata.latestCommittedAt.get(sourceLocator) ?? null };
  });
  const previous = identitiesAt(repoRoot, baseTree, registry);
  const result = lintRoadmapOutcomeCandidates({ registry, artifacts, previousArtifactIdentities: previous });
  const current = new Map(result.artifacts.filter((artifact) => artifact.envelope).map((artifact) => [artifact.sourceLocator, artifact.envelope!]));
  const eventPrevious = boundary.eventBase === boundary.base ? previous
    : identitiesAt(repoRoot, gitTree(repoRoot, boundary.eventBase), registry);
  // Local freshness includes dirty sidecars, but supersession cannot bind an uncommitted target.
  const committedHead = !context && [...current.values()].some((envelope) =>
    envelope.candidates.some((candidate) => candidate.disposition?.kind === "superseded"))
    ? new Map(identitiesAt(repoRoot, headTree, registry).map(({ sourceLocator, envelope }) => [sourceLocator, envelope]))
    : current;
  violations.push(...lintDispositionTransition(repoRoot, boundary.eventBase, eventPrevious, current, currentPaths, registry, committedHead));
  for (const source of affected) {
    const producer = producerFor(source, active)!;
    const sidecar = roadmapSidecarLocator(producer, source);
    const envelope = current.get(source);
    if (currentPaths.has(source) && baseTree.has(sidecar) && !currentPaths.has(sidecar)) {
      violation("missing_post_cutover_sidecar", source, `Restore required sidecar ${sidecar}, or delete the source with it.`);
    }
    if (!envelope || !regular(source)) continue;
    const bytes = read(source);
    if (!outcomeSourceContentMatchesSha256(bytes, envelope.artifact.revisionSha256)) {
      violation("stale_source_revision", source, `Refresh ${sidecar} artifact.revisionSha256 from the current source bytes.`);
    }
    if (changed.has(sidecar)) {
      for (const candidate of envelope.candidates) {
        for (const citation of [...candidate.evidence, ...candidate.provenance]) {
          if (citation.sourceLocator === source && !outcomeSourceContentMatchesSha256(bytes, citation.contentSha256)) {
            violation("stale_source_evidence", source, `Refresh ${candidate.stableOutcomeId}/${citation.id} source evidence hash and regenerate candidate fingerprints.`);
          }
        }
      }
    }
    const prior = previous.find((entry) => entry.sourceLocator === source);
    if (prior && prior.stableArtifactId !== envelope.artifact.stableId) {
      violation("artifact_identity_replaced", source, `Preserve existing stableId ${prior.stableArtifactId}; copied artifacts need distinct paths and identities.`);
    }
  }
  for (const prior of previous) {
    const moved = [...current].filter(([path, envelope]) => path !== prior.sourceLocator && envelope.artifact.stableId === prior.stableArtifactId);
    if (moved.length === 0) continue;
    const oldCount = previous.filter((entry) => entry.stableArtifactId === prior.stableArtifactId).length;
    const newCount = [...current.values()].filter((envelope) => envelope.artifact.stableId === prior.stableArtifactId).length;
    if (oldCount !== 1 || newCount !== 1 || currentPaths.has(prior.sourceLocator) || moved.some(([path]) => baseTree.has(path))) {
      violation("invalid_identity_move", moved[0][0], `Move ${prior.stableArtifactId} as exactly one old/base pair to one new/head pair; remove both old endpoints.`);
    }
  }
  const allViolations = [...result.violations, ...violations];
  return {
    ...result, violations: allViolations,
    productionEnablement: allViolations.length === 0 ? result.productionEnablement : {
      allowed: false,
      blockers: [...new Set([...result.productionEnablement.blockers, "producer_conformance_violations"])],
    },
  };
}

export function roadmapDiffContextFromArgs(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): RoadmapDiffContext | undefined {
  const values = new Map<string, string>();
  for (const argument of args) {
    const match = /^--(event|base|head)=(.+)$/.exec(argument);
    if (!match || values.has(match[1])) throw new Error(`Invalid or duplicate roadmap argument: ${argument}.`);
    values.set(match[1], match[2]);
  }
  const suppliedEnv = [env.ROADMAP_LINT_EVENT, env.ROADMAP_LINT_BASE, env.ROADMAP_LINT_HEAD];
  if (suppliedEnv.some((value) => value !== undefined) && !suppliedEnv.every((value) => typeof value === "string" && value.length > 0)) {
    throw new Error("Partial ROADMAP_LINT_EVENT/BASE/HEAD context; all three event history fields are required.");
  }
  if (values.size === 0 && suppliedEnv.every((value) => value === undefined)) return undefined;
  const event = values.size ? values.get("event") : env.ROADMAP_LINT_EVENT;
  const base = values.size ? values.get("base") : env.ROADMAP_LINT_BASE;
  const head = values.size ? values.get("head") : env.ROADMAP_LINT_HEAD;
  if ((event !== "push" && event !== "pull_request" && event !== "merge_group") || !base || !head) throw new Error("Supply --event=push|pull_request|merge_group, --base=<revision>, and --head=<revision> together.");
  return { event, base, head };
}

export function runRoadmapOutcomeCandidateLint(repoRoot = process.cwd(), context?: RoadmapDiffContext): RoadmapProducerLintResult {
  const registryPath = resolve(repoRoot, "scripts/github-issue-roadmap-producers.json");
  const registryRaw = context
    ? git(repoRoot, ["show", `${eventBoundary(repoRoot, context).head}:scripts/github-issue-roadmap-producers.json`])
    : readFileSync(registryPath, "utf8");
  const registry = parseRoadmapProducerRegistry(JSON.parse(registryRaw));
  const result = lintRoadmapRepositoryTransition(repoRoot, registry, context);
  const counts = result.artifacts.reduce<Record<string, number>>((accumulator, artifact) => {
    accumulator[artifact.status] = (accumulator[artifact.status] ?? 0) + 1;
    return accumulator;
  }, {});
  console.log(JSON.stringify({
    registry: relative(repoRoot, registryPath).replaceAll("\\", "/"),
    counts,
    productionEnablement: result.productionEnablement,
  }, null, 2));
  for (const violation of result.violations) {
    console.error(`${violation.code}: ${violation.sourceLocator}: ${violation.detail}`);
  }
  return result;
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = runRoadmapOutcomeCandidateLint(process.cwd(), roadmapDiffContextFromArgs(process.argv.slice(2)));
    if (result.violations.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
