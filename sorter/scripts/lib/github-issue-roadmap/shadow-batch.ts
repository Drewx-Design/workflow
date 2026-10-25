import { createHash } from "node:crypto";
import {
  chmodSync,
  constants,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";

import {
  discoverRoadmapProducerArtifacts,
  lintRoadmapOutcomeCandidates,
  roadmapSidecarLocator,
  type RoadmapArtifactInput,
  type RoadmapProducerRegistry,
} from "../../lint-roadmap-outcome-candidates";
import { canonicalJson, canonicalJsonSha256, prettyCanonicalJson } from "./canonical-json";
import { validateSafeSourceLocator } from "./outcome-candidate";
import { parseOutcomeEnvelope, type OutcomeEnvelope } from "./outcome-candidate";
import { dispositionHistory, effectiveOutcomeCandidates, type DispositionHistory } from "./disposition-history";
import {
  assessmentStackSha256,
  intakeAssessmentSha256,
  intakeAssessmentJson,
  intakeDispositionSkips,
  intakeSnapshotCoverageSha256,
  parseAssessmentStackDescriptor,
  parseIntakeAssessment,
  type AssessmentStackIdentity,
} from "./intake-assessment";
import {
  INTAKE_OBSERVATION_DIRECTORY,
  INTAKE_OBSERVATION_SCHEMA,
  readIntakeJournalRecord,
  type IntakeObservationRecordV2,
} from "./intake-observation";
import {
  compileIntakeDecision,
  compileIntakeExistenceRoutes,
  deriveIntakeObservationOperands,
} from "./intake-decision";
import {
  createExistenceRecord,
  existenceCitationMatchesContent,
  parseExistenceRecord,
  type ExistenceClause,
  type ExistenceEntryInput,
  type ExistenceRecordV1,
} from "./existence-record";
import { parseIntakeSnapshotV1, type IntakeSnapshotV1 } from "./intake-snapshot";
import {
  assertIntakeSnapshotFreshForShadow,
  runIntakeShadow,
  type IntakeShadowRunInput,
  type IntakeShadowRunResult,
} from "./intake-shadow";
import {
  createReadOnlyGhRunner,
  type GhExecutor,
  type GhRunner,
} from "./read-only-github-reader";
import {
  appendExistenceSuppression,
  listActiveExistenceSuppressions,
} from "./existence-suppression";

export const SHADOW_BATCH_SCHEMA_VERSION =
  "github-issue-roadmap-shadow-batch/v1" as const;
export const SHADOW_COLLECTION_MANIFEST_SCHEMA_VERSION =
  "github-issue-roadmap-shadow-collection-manifest/v1" as const;
export const EXISTENCE_SUPPRESSION_LEDGER_LOCATOR =
  "artifacts/github-issue-roadmap/existence-suppressions.jsonl" as const;

const SHADOW_MAX_TERMINAL_AGE_MS = 55 * 60 * 1_000;
const SHADOW_ENTRY_UPPER_BOUND_MS = 17 * 60 * 1_000;
const SHADOW_TERMINAL_RESERVE_MS = 5 * 60 * 1_000;

export const SHADOW_BATCH_LIMITS = {
  maxStartAgeMs:
    SHADOW_MAX_TERMINAL_AGE_MS - SHADOW_ENTRY_UPPER_BOUND_MS - SHADOW_TERMINAL_RESERVE_MS,
  maxTerminalAgeMs: SHADOW_MAX_TERMINAL_AGE_MS,
  entryUpperBoundMs: SHADOW_ENTRY_UPPER_BOUND_MS,
  terminalReserveMs: SHADOW_TERMINAL_RESERVE_MS,
  maxNonSupersededSpoolBundles: 32,
  maxNonSupersededSpoolBytes: 512 * 1024 * 1024,
} as const;

export const SHADOW_STORAGE_LIMITS = {
  response: 8 * 1024 * 1024,
  page: 8 * 1024 * 1024,
  string: 256 * 1024,
  intake_snapshot: 16 * 1024 * 1024,
  durable_run: 64 * 1024 * 1024,
  scratch_root: 256 * 1024 * 1024,
} as const;

export type ShadowStorageKind = keyof typeof SHADOW_STORAGE_LIMITS;

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;

export interface ShadowEvidenceLineage {
  readonly bundleId: string;
  readonly envelopeSha256: string;
  readonly sourceFingerprints: readonly string[];
  readonly v2SourceFingerprints: readonly string[];
  readonly bundleManifestSha256: string;
}

export type PreparedClassification =
  | "explicit_empty"
  | "pending"
  | "collected_complete"
  | "published_verified"
  | "deferred_by_cap";

export type SealedTerminalState =
  | "explicit_empty"
  | "collected_complete"
  | "published_verified"
  | "observed"
  | "failed"
  | "deferred_by_cap";

export interface ShadowBatchEntry {
  readonly revisionId: string;
  readonly envelopeSha256: string;
  readonly sourceLocator: string;
  readonly candidateLocator: string;
  readonly completedAt: string;
  readonly sourceFingerprints: readonly string[];
  readonly classification: PreparedClassification;
  readonly selected: boolean;
  readonly previouslyDeferred: boolean;
}

export interface PreparedShadowBatchState {
  readonly schemaVersion: typeof SHADOW_BATCH_SCHEMA_VERSION;
  readonly phase: "prepared";
  readonly status: "prepared" | "spool_saturated";
  readonly runId: string;
  readonly generatedAt: string;
  readonly startDeadlineAt: string;
  readonly trustedMainSha: string;
  readonly rollingInputSha: string | null;
  readonly expectedRemoteLease: string | null;
  readonly entries: readonly ShadowBatchEntry[];
  readonly integrityAlerts: readonly string[];
  readonly notifications: readonly string[];
  readonly discoveredCount: number;
  readonly eligibleCount: number;
  readonly explicitEmptyCount: number;
  readonly alreadyObservedCount: number;
  readonly awaitingOperatorCount: number;
}

export interface ShadowBatchTerminalEvent {
  readonly revisionId: string;
  readonly terminalState: "observed" | "failed" | "deferred_by_cap";
}

export interface SealedShadowBatchEntry extends Omit<ShadowBatchEntry, "classification"> {
  readonly terminalState: SealedTerminalState;
}

export interface SealedShadowBatchManifest {
  readonly schemaVersion: typeof SHADOW_COLLECTION_MANIFEST_SCHEMA_VERSION;
  readonly phase: "sealed";
  readonly status: "zero_new" | "awaiting_operator" | "partial_failure" | "failed" | "spool_saturated";
  readonly runId: string;
  readonly generatedAt: string;
  readonly trustedMainSha: string;
  readonly rollingInputSha: string | null;
  readonly expectedRemoteLease: string | null;
  readonly counts: {
    readonly discovered: number;
    readonly eligible: number;
    readonly alreadyObserved: number;
    readonly awaitingOperator: number;
    readonly explicitEmpty: number;
    readonly attempted: number;
    readonly observed: number;
    readonly failed: number;
    readonly deferredByCap: number;
  };
  readonly entries: readonly SealedShadowBatchEntry[];
  readonly integrityAlerts: readonly string[];
  readonly notifications: readonly string[];
}

interface ShadowBatchLimitsInput {
  readonly maxStarts?: number;
  readonly maxStartAgeMs?: number;
}

export interface PrepareShadowBatchInput {
  readonly repoRoot?: string;
  readonly dispositionHistory?: typeof dispositionHistory;
  readonly runId: string;
  readonly generatedAt: string;
  readonly trustedMainSha: string;
  readonly rollingInputSha: string | null;
  readonly expectedRemoteLease: string | null;
  readonly registry: RoadmapProducerRegistry;
  readonly artifacts: readonly RoadmapArtifactInput[];
  readonly originMain: readonly ShadowEvidenceLineage[];
  readonly spool: readonly ShadowEvidenceLineage[];
  readonly rolling: readonly ShadowEvidenceLineage[];
  readonly previousDeferredRevisionIds: readonly string[];
  readonly spoolUsage?: {
    readonly nonSupersededBundleCount: number;
    readonly nonSupersededBytes: number;
  };
  readonly limits?: ShadowBatchLimitsInput;
  readonly startedAtMs?: number;
  readonly clock?: () => number;
}

function sha256(value: string, context: string): string {
  const normalized = value.toLowerCase();
  if (!SHA256.test(normalized)) throw new Error(`${context} must be a lowercase SHA-256 identity.`);
  return normalized;
}

function gitSha(value: string, context: string): string {
  const normalized = value.toLowerCase();
  if (!GIT_SHA.test(normalized)) throw new Error(`${context} must be a 40-character Git SHA.`);
  return normalized;
}

function nonEmpty(value: string, context: string): string {
  if (value.trim() === "") throw new Error(`${context} must be non-empty.`);
  return value;
}

function sortedFingerprints(values: readonly string[], context: string): string[] {
  const result = values.map((value, index) => sha256(value, `${context}[${index}]`))
    .sort((left, right) => left.localeCompare(right, "en"));
  if (new Set(result).size !== result.length) throw new Error(`${context} contains duplicates.`);
  return result;
}

function normalizedLineage(value: ShadowEvidenceLineage, context: string): ShadowEvidenceLineage {
  const sourceFingerprints = sortedFingerprints(value.sourceFingerprints, `${context}.sourceFingerprints`);
  const v2SourceFingerprints = sortedFingerprints(
    value.v2SourceFingerprints ?? [],
    `${context}.v2SourceFingerprints`,
  );
  if (v2SourceFingerprints.some((fingerprint) => !sourceFingerprints.includes(fingerprint))) {
    throw new Error(`${context}.v2SourceFingerprints must be a subset of sourceFingerprints.`);
  }
  return {
    bundleId: nonEmpty(value.bundleId, `${context}.bundleId`),
    envelopeSha256: sha256(value.envelopeSha256, `${context}.envelopeSha256`),
    sourceFingerprints,
    v2SourceFingerprints,
    bundleManifestSha256: sha256(value.bundleManifestSha256, `${context}.bundleManifestSha256`),
  };
}

function revisionIdentity(envelopeSha256: string, sourceFingerprints: readonly string[]): string {
  return canonicalJsonSha256({ envelopeSha256, sourceFingerprints });
}

function sameRevision(
  lineage: ShadowEvidenceLineage,
  envelopeSha256: string,
  sourceFingerprints: readonly string[],
): boolean {
  return lineage.envelopeSha256 === envelopeSha256 &&
    JSON.stringify(lineage.sourceFingerprints) === JSON.stringify(sourceFingerprints);
}

function sameCollectableRevision(
  lineage: ShadowEvidenceLineage,
  envelopeSha256: string,
  sourceFingerprints: readonly string[],
): boolean {
  return sameRevision(lineage, envelopeSha256, sourceFingerprints) &&
    JSON.stringify(lineage.v2SourceFingerprints) === JSON.stringify(sourceFingerprints);
}

function exactLineage(left: ShadowEvidenceLineage, right: ShadowEvidenceLineage): boolean {
  return left.bundleId === right.bundleId &&
    left.bundleManifestSha256 === right.bundleManifestSha256 &&
    JSON.stringify(left.v2SourceFingerprints) === JSON.stringify(right.v2SourceFingerprints) &&
    sameRevision(left, right.envelopeSha256, right.sourceFingerprints);
}

function integerAtLeastZero(value: number, context: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${context} must be a non-negative integer.`);
  return value;
}

export function assertShadowStorageSize(kind: ShadowStorageKind, bytes: number): void {
  integerAtLeastZero(bytes, `${kind} bytes`);
  const cap = SHADOW_STORAGE_LIMITS[kind];
  if (bytes > cap) {
    throw new Error(`${kind} exceeds its ${cap}-byte hard cap; refusing rather than truncating.`);
  }
}

function isoTimestamp(value: string, context: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${context} must be an ISO-8601 timestamp.`);
  }
  return new Date(value).toISOString();
}

/**
 * Composition boundary for registry discovery, durable-lineage inspection, ordering, and caps.
 * It accepts only already-read data. Git trees and spool paths are inspected by trusted current-main
 * code before their summaries reach this pure function.
 */
export function prepareShadowBatchState(input: PrepareShadowBatchInput): PreparedShadowBatchState {
  nonEmpty(input.runId, "runId");
  const generatedAt = isoTimestamp(input.generatedAt, "generatedAt");
  const trustedMainSha = gitSha(input.trustedMainSha, "trustedMainSha");
  const history = (input.dispositionHistory ?? dispositionHistory)(trustedMainSha, { repoRoot: input.repoRoot ?? process.cwd() });
  const rollingInputSha = input.rollingInputSha === null
    ? null
    : gitSha(input.rollingInputSha, "rollingInputSha");
  const expectedRemoteLease = input.expectedRemoteLease === null
    ? null
    : gitSha(input.expectedRemoteLease, "expectedRemoteLease");
  const lint = lintRoadmapOutcomeCandidates({ registry: input.registry, artifacts: input.artifacts });
  if (lint.violations.length > 0) {
    if (lint.violations.some(({ code }) => code === "duplicate_artifact_identity")) {
      throw new Error(
        "Multiple discovered artifacts can map to one revision identity; refusing ambiguous max-start and terminal-event addressing.",
      );
    }
    throw new Error(`Roadmap producer discovery failed: ${lint.violations.map((entry) =>
      `${entry.code}:${entry.sourceLocator}`).join(", ")}`);
  }

  const originMain = input.originMain.map((entry, index) => normalizedLineage(entry, `originMain[${index}]`));
  const spool = input.spool.map((entry, index) => normalizedLineage(entry, `spool[${index}]`));
  const rolling = input.rolling.map((entry, index) => normalizedLineage(entry, `rolling[${index}]`));
  const previousDeferred = new Set(input.previousDeferredRevisionIds.map((value, index) =>
    sha256(value, `previousDeferredRevisionIds[${index}]`)));
  const alerts = rolling.flatMap((record): string[] =>
    spool.some((bundle) => exactLineage(bundle, record))
      ? []
      : [`Rolling evidence bundle ${record.bundleId} lacks exact retained local spool lineage and cannot suppress collection.`]);

  const discovered = lint.artifacts.flatMap((artifact): ShadowBatchEntry[] => {
    if (artifact.status !== "valid_candidates" && artifact.status !== "explicit_empty") return [];
    if (artifact.envelope === null) throw new Error(`Validated artifact ${artifact.sourceLocator} lost its envelope.`);
    const envelopeSha256 = canonicalJsonSha256(artifact.envelope);
    const selection = effectiveOutcomeCandidates(artifact.envelope, history);
    const sourceFingerprints = sortedFingerprints(
      selection.active.map(({ sourceFingerprint }) => sourceFingerprint),
      `${artifact.sourceLocator}.sourceFingerprints`,
    );
    const revisionId = revisionIdentity(envelopeSha256, sourceFingerprints);
    const producer = input.registry.producers.find(({ kind }) => kind === artifact.producerKind);
    if (producer === undefined) {
      throw new Error(`Validated artifact ${artifact.sourceLocator} lost its producer registry entry.`);
    }
    const candidateLocator = roadmapSidecarLocator(producer, artifact.sourceLocator);
    const completedAt = input.artifacts.find(({ sourceLocator }) =>
      sourceLocator === artifact.sourceLocator)?.completedAt;
    if (completedAt === null || completedAt === undefined) {
      throw new Error(`Validated artifact ${artifact.sourceLocator} requires a stable completion timestamp.`);
    }
    const normalizedCompletedAt = isoTimestamp(completedAt, `${artifact.sourceLocator}.completedAt`);
    const publishedOnMain = originMain.some((record) =>
      sameCollectableRevision(record, envelopeSha256, sourceFingerprints));
    const localBundle = spool.find((record) => sameCollectableRevision(record, envelopeSha256, sourceFingerprints));
    const publishedOnRolling = localBundle !== undefined && rolling.some((record) =>
      exactLineage(localBundle, record));
    const classification: PreparedClassification = selection.active.length === 0
      ? "explicit_empty"
      : publishedOnMain || publishedOnRolling
        ? "published_verified"
        : localBundle !== undefined
          ? "collected_complete"
          : "pending";
    return [{
      revisionId,
      envelopeSha256,
      sourceLocator: artifact.sourceLocator,
      candidateLocator,
      completedAt: normalizedCompletedAt,
      sourceFingerprints,
      classification,
      selected: false,
      previouslyDeferred: previousDeferred.has(revisionId),
    }];
  }).sort((left, right) => left.sourceLocator.localeCompare(right.sourceLocator, "en"));
  const revisionOwners = new Map<string, string>();
  for (const entry of discovered) {
    const prior = revisionOwners.get(entry.revisionId);
    if (prior !== undefined) {
      throw new Error(
        `Multiple discovered artifacts (${prior}, ${entry.sourceLocator}) share revision identity ${entry.revisionId}; ` +
        "refusing ambiguous max-start and terminal-event addressing.",
      );
    }
    revisionOwners.set(entry.revisionId, entry.sourceLocator);
  }

  const spoolUsage = input.spoolUsage ?? {
    nonSupersededBundleCount: spool.length,
    nonSupersededBytes: 0,
  };
  const saturated =
    integerAtLeastZero(spoolUsage.nonSupersededBundleCount, "spoolUsage.nonSupersededBundleCount") >=
      SHADOW_BATCH_LIMITS.maxNonSupersededSpoolBundles ||
    integerAtLeastZero(spoolUsage.nonSupersededBytes, "spoolUsage.nonSupersededBytes") >=
      SHADOW_BATCH_LIMITS.maxNonSupersededSpoolBytes;
  const maxStarts = input.limits?.maxStarts ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxStarts) || maxStarts < 0) throw new Error("limits.maxStarts must be a non-negative integer.");
  const maxStartAgeMs = input.limits?.maxStartAgeMs ?? SHADOW_BATCH_LIMITS.maxStartAgeMs;
  if (!Number.isSafeInteger(maxStartAgeMs) || maxStartAgeMs < 0) {
    throw new Error("limits.maxStartAgeMs must be a non-negative integer.");
  }
  const startedAtMs = input.startedAtMs ?? Date.parse(generatedAt);
  if (!Number.isFinite(startedAtMs)) throw new Error("startedAtMs must be a finite timestamp.");
  const startDeadlineMs = startedAtMs + maxStartAgeMs;
  if (!Number.isFinite(startDeadlineMs)) throw new Error("The shadow batch start deadline is outside the supported date range.");
  const startDeadlineAt = new Date(startDeadlineMs).toISOString();
  const clock = input.clock ?? (() => startedAtMs);
  const pendingInStartOrder = discovered.filter(({ classification }) => classification === "pending")
    .sort((left, right) =>
      Number(right.previouslyDeferred) - Number(left.previouslyDeferred) ||
      left.completedAt.localeCompare(right.completedAt, "en") ||
      left.sourceLocator.localeCompare(right.sourceLocator, "en") ||
      left.revisionId.localeCompare(right.revisionId, "en"));
  const selected = new Set<string>();
  if (!saturated) {
    for (const entry of pendingInStartOrder) {
      if (selected.size >= maxStarts || clock() - startedAtMs >= maxStartAgeMs) break;
      selected.add(entry.revisionId);
    }
  }
  const classifiedPending = new Map(pendingInStartOrder.map((entry): [string, ShadowBatchEntry] => {
    return [entry.revisionId, selected.has(entry.revisionId)
      ? { ...entry, selected: true }
      : { ...entry, classification: "deferred_by_cap" }];
  }));
  const entries = [
    ...discovered.filter(({ classification }) => classification !== "pending"),
    ...pendingInStartOrder.map(({ revisionId }) => classifiedPending.get(revisionId)!),
  ];
  const deferredCount = entries.filter(({ classification }) => classification === "deferred_by_cap").length;
  const notifications = deferredCount > 0 && previousDeferred.size > 0
    ? ["Consecutive deferred-by-cap work remains; use the manual recovery path to drain the stable pending cohort."]
    : [];
  for (const artifact of lint.artifacts) {
    if (artifact.envelope === null) continue;
    for (const candidate of effectiveOutcomeCandidates(artifact.envelope, history).dispositioned) {
      notifications.push(`dispositioned: ${candidate.sourceFingerprint} (${candidate.stableOutcomeId}); skipped shadow collection.`);
    }
  }
  const eligible = entries.filter(({ sourceFingerprints }) => sourceFingerprints.length > 0);
  const alreadyObserved = eligible.filter(({ classification }) =>
    classification === "collected_complete" || classification === "published_verified");
  return {
    schemaVersion: SHADOW_BATCH_SCHEMA_VERSION,
    phase: "prepared",
    status: saturated ? "spool_saturated" : "prepared",
    runId: input.runId,
    generatedAt,
    startDeadlineAt,
    trustedMainSha,
    rollingInputSha,
    expectedRemoteLease,
    entries,
    integrityAlerts: [...new Set(alerts)].sort((left, right) => left.localeCompare(right, "en")),
    notifications,
    discoveredCount: entries.length,
    eligibleCount: eligible.length,
    explicitEmptyCount: entries.filter(({ classification }) => classification === "explicit_empty").length,
    alreadyObservedCount: alreadyObserved.length,
    awaitingOperatorCount: entries.filter(({ classification }) => classification === "collected_complete").length,
  };
}

export function sealShadowBatchManifest(
  prepared: PreparedShadowBatchState,
  terminalEvents: readonly ShadowBatchTerminalEvent[],
): SealedShadowBatchManifest {
  if (prepared.phase !== "prepared") throw new Error("Only a prepared shadow batch can be sealed.");
  const revisionIds = new Set<string>();
  for (const entry of prepared.entries) {
    if (revisionIds.has(entry.revisionId)) {
      throw new Error(
        `Prepared manifest contains duplicate revision identity ${entry.revisionId}; one terminal event cannot address multiple entries.`,
      );
    }
    revisionIds.add(entry.revisionId);
  }
  const selected = prepared.entries.filter(({ selected }) => selected);
  const events = new Map<string, ShadowBatchTerminalEvent>();
  for (const event of terminalEvents) {
    if (events.has(event.revisionId)) throw new Error(`Revision ${event.revisionId} has duplicate terminal events.`);
    if (!selected.some(({ revisionId }) => revisionId === event.revisionId)) {
      throw new Error(`Terminal event ${event.revisionId} does not belong to a selected revision.`);
    }
    events.set(event.revisionId, event);
  }
  const missing = selected.filter(({ revisionId }) => !events.has(revisionId));
  if (missing.length > 0) {
    throw new Error(`Cannot seal while selected revisions lack terminal events: ${missing.map(({ revisionId }) => revisionId).join(", ")}.`);
  }
  const entries = prepared.entries.map((entry): SealedShadowBatchEntry => {
    const event = events.get(entry.revisionId);
    let terminalState: SealedTerminalState;
    if (event !== undefined) {
      terminalState = event.terminalState;
    } else if (entry.classification === "pending") {
      throw new Error(`Pending revision ${entry.revisionId} lacks a terminal event.`);
    } else {
      terminalState = entry.classification;
    }
    const { classification, ...rest } = entry;
    void classification;
    return {
      ...rest,
      selected: terminalState === "deferred_by_cap" ? false : rest.selected,
      terminalState,
    };
  });
  const observed = entries.filter(({ terminalState }) => terminalState === "observed").length;
  const failed = entries.filter(({ terminalState }) => terminalState === "failed").length;
  const deferredByCap = entries.filter(({ terminalState }) => terminalState === "deferred_by_cap").length;
  const awaitingOperator = prepared.awaitingOperatorCount + observed;
  const status: SealedShadowBatchManifest["status"] = prepared.status === "spool_saturated"
    ? "spool_saturated"
    : failed > 0 && awaitingOperator > 0
      ? "partial_failure"
      : failed > 0
        ? "failed"
        : awaitingOperator > 0
          ? "awaiting_operator"
          : "zero_new";
  return {
    schemaVersion: SHADOW_COLLECTION_MANIFEST_SCHEMA_VERSION,
    phase: "sealed",
    status,
    runId: prepared.runId,
    generatedAt: prepared.generatedAt,
    trustedMainSha: prepared.trustedMainSha,
    rollingInputSha: prepared.rollingInputSha,
    expectedRemoteLease: prepared.expectedRemoteLease,
    counts: {
      discovered: prepared.discoveredCount,
      eligible: prepared.eligibleCount,
      alreadyObserved: prepared.alreadyObservedCount,
      awaitingOperator,
      explicitEmpty: prepared.explicitEmptyCount,
      attempted: observed + failed,
      observed,
      failed,
      deferredByCap,
    },
    entries,
    integrityAlerts: prepared.integrityAlerts,
    notifications: prepared.notifications,
  };
}

export function discoverShadowBatchArtifacts(
  repoRoot: string,
  registry: RoadmapProducerRegistry,
): RoadmapArtifactInput[] {
  return discoverRoadmapProducerArtifacts(repoRoot, registry);
}

export interface TrustedCheckoutInput {
  readonly expectedRepository: string;
  readonly originUrl: string;
  readonly headSha: string;
  readonly originMainSha: string;
  readonly trustedMainSha: string;
  readonly statusPorcelain: string;
  readonly rollingInputSha: string | null;
  readonly rollingDescendsFromTrustedMain: boolean | null;
}

function repositoryFromOrigin(originUrl: string): string | null {
  const match = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i.exec(originUrl.trim());
  return match?.[1]?.replace(/\.git$/i, "") ?? null;
}

export function validateTrustedCheckout(input: TrustedCheckoutInput): void {
  if (repositoryFromOrigin(input.originUrl)?.toLowerCase() !== input.expectedRepository.toLowerCase()) {
    throw new Error("Trusted checkout origin does not match the expected repository identity.");
  }
  const trusted = gitSha(input.trustedMainSha, "trustedMainSha");
  if (gitSha(input.headSha, "headSha") !== trusted || gitSha(input.originMainSha, "originMainSha") !== trusted) {
    throw new Error("Trusted checkout is stale; HEAD and origin/main must equal trustedMainSha.");
  }
  if (input.statusPorcelain.trim() !== "") {
    throw new Error("Trusted checkout must be clean before repository code or capture runs.");
  }
  if (input.rollingInputSha !== null) {
    gitSha(input.rollingInputSha, "rollingInputSha");
    if (input.rollingDescendsFromTrustedMain !== true) {
      throw new Error("Rolling evidence ancestry is unexpected and cannot be inspected.");
    }
  }
}

export interface RollingTreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly objectType: string;
  readonly changeType: "added" | "modified";
}

export function validateRollingTreeEntries(entries: readonly RollingTreeEntry[]): void {
  const identities = new Map<string, string>();
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path, "en"))) {
    const path = validateSafeSourceLocator(entry.path, "rolling evidence path");
    if (entry.changeType !== "added") {
      throw new Error(`Rolling evidence is append-only; modified path ${path} is forbidden.`);
    }
    if (path !== path.normalize("NFC") || !path.startsWith("artifacts/github-issue-roadmap/") ||
        ![".json", ".jsonl"].includes(extname(path).toLowerCase())) {
      throw new Error(`Rolling tree path ${path} is not a canonical evidence artifact.`);
    }
    if (entry.mode !== "100644" || entry.objectType !== "blob") {
      throw new Error(`Rolling evidence ${path} must be a non-executable regular blob with mode 100644.`);
    }
    const collisionIdentity = path.normalize("NFKC").toLocaleLowerCase("en-US");
    const prior = identities.get(collisionIdentity);
    if (prior !== undefined && prior !== path) {
      throw new Error(`Rolling evidence paths ${prior} and ${path} collide by case or Unicode identity.`);
    }
    identities.set(collisionIdentity, path);
  }
}

export interface SpoolInspectionInput {
  readonly root: {
    readonly exists: boolean;
    readonly directory: boolean;
    readonly linkOrReparsePoint: boolean;
    readonly ownerOnly: boolean;
  };
  readonly bundles: readonly {
    readonly name: string;
    readonly state: "partial" | "sealed";
    readonly directory: boolean;
    readonly linkOrReparsePoint: boolean;
    readonly identityStable: boolean;
    readonly hashesValid: boolean;
    readonly bytes: number;
    readonly lineage: ShadowEvidenceLineage;
  }[];
}

export interface SpoolInspectionResult {
  readonly initialized: boolean;
  readonly lineages: readonly ShadowEvidenceLineage[];
  readonly usage: {
    readonly nonSupersededBundleCount: number;
    readonly nonSupersededBytes: number;
  };
}

/**
 * Validates facts collected by a no-follow, identity-checked spool reader. Any partial promotion
 * is an integrity failure that must be diagnosed before collection can resume.
 */
export function validateSpoolInspection(input: SpoolInspectionInput): SpoolInspectionResult {
  if (!input.root.exists) {
    if (input.bundles.length > 0) throw new Error("A missing spool root cannot contain bundles.");
    return {
      initialized: true,
      lineages: [],
      usage: { nonSupersededBundleCount: 0, nonSupersededBytes: 0 },
    };
  }
  if (!input.root.directory || input.root.linkOrReparsePoint || !input.root.ownerOnly) {
    throw new Error("Spool root must be a private, owner-only, non-link directory.");
  }
  const lineages: ShadowEvidenceLineage[] = [];
  let bytes = 0;
  const names = new Set<string>();
  const bundleIds = new Set<string>();
  for (const bundle of input.bundles) {
    nonEmpty(bundle.name, "spool bundle name");
    if (names.has(bundle.name)) throw new Error(`Spool bundle ${bundle.name} is duplicated.`);
    names.add(bundle.name);
    if (bundle.state === "partial") {
      throw new Error(`Spool bundle ${bundle.name} is a partial promotion and requires reconciliation.`);
    }
    if (!bundle.directory || bundle.linkOrReparsePoint) {
      throw new Error(`Sealed spool bundle ${bundle.name} must be a non-link directory.`);
    }
    if (!bundle.identityStable) {
      throw new Error(`Sealed spool bundle ${bundle.name} changed identity during inspection.`);
    }
    if (!bundle.hashesValid) {
      throw new Error(`Sealed spool bundle ${bundle.name} failed canonical hash validation.`);
    }
    assertShadowStorageSize("durable_run", bundle.bytes);
    const lineage = normalizedLineage(bundle.lineage, `spool bundle ${bundle.name}.lineage`);
    if (bundleIds.has(lineage.bundleId)) {
      throw new Error(`Spool bundle lineage ${lineage.bundleId} is duplicated.`);
    }
    bundleIds.add(lineage.bundleId);
    bytes += bundle.bytes;
    if (!Number.isSafeInteger(bytes)) throw new Error("Spool byte accounting overflowed.");
    lineages.push(lineage);
  }
  return {
    initialized: false,
    lineages: lineages.sort((left, right) => left.bundleId.localeCompare(right.bundleId, "en")),
    usage: {
      nonSupersededBundleCount: lineages.length,
      nonSupersededBytes: bytes,
    },
  };
}

export interface RoadmapShadowStateRoots {
  readonly stateRoot: string;
  readonly spoolRoot: string;
  readonly operatorJournalRoot: string;
}

export function resolveRoadmapShadowStateRoots(gitCommonDir: string): RoadmapShadowStateRoots {
  const canonicalCommonDir = resolve(gitCommonDir);
  const mainCheckoutRoot = dirname(canonicalCommonDir);
  const repositoryParent = dirname(mainCheckoutRoot);
  const identity = createHash("sha256")
    .update(process.platform === "win32" ? canonicalCommonDir.toLowerCase() : canonicalCommonDir, "utf8")
    .digest("hex")
    .slice(0, 16);
  const stateRoot = join(repositoryParent, `.example-repo-roadmap-shadow-${identity}`);
  return {
    stateRoot,
    spoolRoot: join(stateRoot, "roadmap-shadow-spool"),
    operatorJournalRoot: join(stateRoot, "roadmap-shadow-operator-journal"),
  };
}

export interface ScheduledCaptureSession {
  readonly runGh: GhRunner;
  readonly ghConfigDir: string;
  readonly dispose: () => void;
}

export interface ScheduledCaptureOptions {
  readonly execute?: GhExecutor;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly temporaryRoot?: string;
}

export interface CredentialCleanExecutionProfile {
  readonly effectiveIdentity: string;
  readonly expectedIdentity: string;
  readonly visibleOperatorCredentialPaths: readonly string[];
  readonly gitCredentialHelpers: readonly string[];
  readonly sshAgentVisible: boolean;
  readonly sshPrivateKeysVisible: boolean;
  readonly publisherEnvironmentVariables: readonly string[];
  readonly token: {
    readonly repositories: readonly string[];
    readonly projects: readonly string[];
    readonly permissions: Readonly<Record<string, string>>;
  };
  readonly expected: {
    readonly repositories: readonly string[];
    readonly projects: readonly string[];
  };
}

function sortedUnique(values: readonly string[], context: string): string[] {
  const sorted = values.map((value) => nonEmpty(value, context))
    .sort((left, right) => left.localeCompare(right, "en"));
  if (new Set(sorted).size !== sorted.length) throw new Error(`${context} contains duplicates.`);
  return sorted;
}

export function validateCredentialCleanExecutionProfile(
  profile: CredentialCleanExecutionProfile,
): void {
  if (nonEmpty(profile.effectiveIdentity, "effective identity") !==
      nonEmpty(profile.expectedIdentity, "expected identity")) {
    throw new Error("Credential-clean execution profile is running as the wrong OS identity.");
  }
  if (profile.visibleOperatorCredentialPaths.length > 0) {
    throw new Error("Credential-clean execution profile can see operator Git or gh credential paths.");
  }
  if (profile.gitCredentialHelpers.length > 0) {
    throw new Error("Credential-clean execution profile can reach a Git credential helper.");
  }
  if (profile.sshAgentVisible || profile.sshPrivateKeysVisible) {
    throw new Error("Credential-clean execution profile can reach an operator SSH agent or key.");
  }
  if (profile.publisherEnvironmentVariables.length > 0) {
    throw new Error("Credential-clean execution profile can see publisher environment authority.");
  }
  const actualRepositories = sortedUnique(profile.token.repositories, "token repositories");
  const expectedRepositories = sortedUnique(profile.expected.repositories, "expected repositories");
  const actualProjects = sortedUnique(profile.token.projects, "token projects");
  const expectedProjects = sortedUnique(profile.expected.projects, "expected projects");
  if (JSON.stringify(actualRepositories) !== JSON.stringify(expectedRepositories) ||
      JSON.stringify(actualProjects) !== JSON.stringify(expectedProjects)) {
    throw new Error("Read-only token resource list does not match the declared repository/Project allowlist.");
  }
  const expectedPermissions = [
    "contents",
    "issueFields",
    "issues",
    "metadata",
    "organizationProjects",
    "pullRequests",
  ];
  const permissionNames = Object.keys(profile.token.permissions).sort((left, right) =>
    left.localeCompare(right, "en"));
  if (JSON.stringify(permissionNames) !== JSON.stringify(expectedPermissions.sort((left, right) =>
    left.localeCompare(right, "en"))) ||
      permissionNames.some((name) => profile.token.permissions[name] !== "read")) {
    throw new Error("Scheduled token permissions must be the exact declared read-only permission set; write authority is forbidden.");
  }
}

const SAFE_ENV_NAMES = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "LANG", "LC_ALL", "NO_COLOR",
]);

const HOST_GIT_ISOLATION_ENV_NAMES = new Set([
  "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL", "GIT_TERMINAL_PROMPT",
]);

function assertHostGitIsolationEnvironment(environment: Readonly<Record<string, string | undefined>>): void {
  const values = new Map(Object.entries(environment).map(([name, value]) => [name.toUpperCase(), value]));
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  const noSystem = values.get("GIT_CONFIG_NOSYSTEM");
  if (noSystem !== undefined && noSystem !== "1") {
    throw new Error("Scheduled credential-clean capture requires GIT_CONFIG_NOSYSTEM=1 when configured.");
  }
  const system = values.get("GIT_CONFIG_SYSTEM");
  if (system !== undefined && system !== nullDevice) {
    throw new Error(`Scheduled credential-clean capture requires GIT_CONFIG_SYSTEM=${nullDevice} when configured.`);
  }
  const global = values.get("GIT_CONFIG_GLOBAL");
  if (global !== undefined && global !== nullDevice && !isAbsolute(global)) {
    throw new Error("Scheduled credential-clean capture requires an absolute GIT_CONFIG_GLOBAL path.");
  }
  const terminalPrompt = values.get("GIT_TERMINAL_PROMPT");
  if (terminalPrompt !== undefined && terminalPrompt !== "0") {
    throw new Error("Scheduled credential-clean capture requires GIT_TERMINAL_PROMPT=0 when configured.");
  }
}

function assertCredentialCleanEnvironment(environment: Readonly<Record<string, string | undefined>>): string {
  const token = environment.GH_READ_ONLY_TOKEN;
  if (typeof token !== "string" || token.trim() === "") {
    throw new Error("Scheduled credential-clean capture requires an explicit GH_READ_ONLY_TOKEN.");
  }
  assertHostGitIsolationEnvironment(environment);
  const forbidden = Object.entries(environment).flatMap(([name, value]): string[] => {
    if (!value || name === "GH_READ_ONLY_TOKEN") return [];
    if (HOST_GIT_ISOLATION_ENV_NAMES.has(name.toUpperCase())) return [];
    const credentialLike = /(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i.test(name);
    const authorityLike = /^(?:GH_|GITHUB_|GIT_|SSH_|GCM_)/i.test(name) || /PUBLISH|WRITE/i.test(name);
    return credentialLike || authorityLike ? [name] : [];
  }).sort((left, right) => left.localeCompare(right, "en"));
  if (forbidden.length > 0) {
    throw new Error(`Scheduled credential-clean capture rejects ambient authority variables: ${forbidden.join(", ")}.`);
  }
  return token;
}

function assertPrivateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Scheduled GH_CONFIG_DIR must be a newly-created non-link directory.");
  }
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("Scheduled GH_CONFIG_DIR must have owner-only 0700 permissions.");
  }
}

function redact(value: string, secret: string): string {
  const variants = [secret, encodeURIComponent(secret), Buffer.from(secret, "utf8").toString("base64")]
    .filter((entry) => entry !== "");
  return variants.reduce((message, entry) => message.split(entry).join("[REDACTED]"), value);
}

/**
 * Scheduled-only capture session. Interactive preflight keeps its established runner defaults;
 * scheduled callers must cross this credential-clean, fresh-config composition boundary.
 */
export function createScheduledCaptureSession(
  options: ScheduledCaptureOptions = {},
): ScheduledCaptureSession {
  const inputEnvironment = options.environment ?? process.env;
  const token = assertCredentialCleanEnvironment(inputEnvironment);
  const temporaryRoot = resolve(options.temporaryRoot ?? tmpdir());
  const rootStat = lstatSync(temporaryRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Scheduled capture temporary root must be a non-link directory.");
  }
  const ghConfigDir = mkdtempSync(join(temporaryRoot, "example-repo-roadmap-read-only-"));
  chmodSync(ghConfigDir, 0o700);
  assertPrivateDirectory(ghConfigDir);
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: inputEnvironment.NODE_ENV === "development" || inputEnvironment.NODE_ENV === "test"
      ? inputEnvironment.NODE_ENV
      : "production",
  };
  for (const name of SAFE_ENV_NAMES) {
    const value = inputEnvironment[name];
    if (value !== undefined) environment[name] = value;
  }
  Object.assign(environment, {
    GH_READ_ONLY_TOKEN: token,
    GH_CONFIG_DIR: ghConfigDir,
    GH_HOST: "github.com",
    HOME: ghConfigDir,
    XDG_CONFIG_HOME: ghConfigDir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  });
  const delegate = createReadOnlyGhRunner({ execute: options.execute, environment });
  const runGh: GhRunner = (args) => {
    try {
      const serializedArgs = JSON.stringify(args);
      if ([token, encodeURIComponent(token), Buffer.from(token, "utf8").toString("base64")]
        .some((variant) => variant !== "" && serializedArgs.includes(variant))) {
        throw new Error("Scheduled GitHub arguments contained [REDACTED] credential material.");
      }
      const output = delegate(args);
      assertShadowStorageSize("response", Buffer.byteLength(output, "utf8"));
      if ([token, encodeURIComponent(token), Buffer.from(token, "utf8").toString("base64")]
        .some((variant) => variant !== "" && output.includes(variant))) {
        throw new Error("Scheduled GitHub response contained [REDACTED] credential material.");
      }
      return output;
    } catch (error) {
      const failure = error as Error & { stderr?: string | Buffer };
      const message = redact(`${failure.message}\n${String(failure.stderr ?? "")}`.trim(), token);
      throw new Error(message, { cause: error });
    }
  };
  let disposed = false;
  return {
    runGh,
    ghConfigDir,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      assertPrivateDirectory(ghConfigDir);
      rmSync(ghConfigDir, { recursive: true, force: false });
    },
  };
}

export type ShadowBatchSyncWriter = (
  descriptor: number,
  buffer: Buffer,
  offset: number,
  length: number,
) => number;

const defaultSyncWriter: ShadowBatchSyncWriter = (descriptor, buffer, offset, length) =>
  writeSync(descriptor, buffer, offset, length);

function writeAllSync(
  descriptor: number,
  bytes: Buffer,
  writer: ShadowBatchSyncWriter = defaultSyncWriter,
): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writer(descriptor, bytes, offset, bytes.byteLength - offset);
    if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.byteLength - offset) {
      throw new Error("Synchronous artifact write failed to make valid forward progress.");
    }
    offset += written;
  }
}

export function appendShadowBatchLedgerEvent(
  path: string,
  event: unknown,
  writer: ShadowBatchSyncWriter = defaultSyncWriter,
): void {
  const flags = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY |
    (constants.O_NOFOLLOW ?? 0);
  const descriptor = openSync(path, flags, 0o600);
  try {
    writeAllSync(descriptor, Buffer.from(`${canonicalJson(event)}\n`, "utf8"), writer);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function writeOnceCanonicalJson(path: string, value: unknown): void {
  const contents = prettyCanonicalJson(value);
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink() || readFileSync(path, "utf8") !== contents) {
      throw new Error(`Write-once artifact ${path} already exists with different or untrusted bytes.`);
    }
    return;
  }
  const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY |
    (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeAllSync(descriptor, Buffer.from(contents, "utf8"));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export const SHADOW_ASSESSMENT_REQUEST_SCHEMA_VERSION =
  "github-issue-roadmap-shadow-assessment-request/v1" as const;
const SHADOW_LEDGER_EVENT_SCHEMA_VERSION = "github-issue-roadmap-shadow-ledger-event/v1" as const;
const DEFAULT_ASSESSMENT_PROMPT_LOCATOR = "scripts/github-issue-roadmap-assessment-prompt.md";
const DEFAULT_ASSESSMENT_STACK_LOCATOR = "scripts/github-issue-roadmap-assessment-stack.json";
const DEFAULT_ASSESSMENT_SCHEMA_LOCATOR = "scripts/github-issue-roadmap-assessment-schema.json";

export interface ShadowAssessmentRequest {
  readonly skipped?: ReturnType<typeof intakeDispositionSkips>;
  readonly schemaVersion: typeof SHADOW_ASSESSMENT_REQUEST_SCHEMA_VERSION;
  readonly requestSha256: string;
  readonly state: "awaiting_assessment";
  readonly runId: string;
  readonly revisionId: string;
  readonly requestSequence: number;
  readonly continuationNonce: string;
  readonly envelopeSha256: string;
  readonly archivedCandidate: {
    readonly locator: string;
    readonly contentSha256: string;
  };
  readonly candidates: readonly {
    readonly sourceFingerprint: string;
    readonly emissionContentSha256: string;
  }[];
  readonly intakeSnapshot: {
    readonly locator: string;
    readonly contentSha256: string;
    readonly fileSha256: string;
    readonly coverageSha256: string;
  };
  readonly assessmentStack: AssessmentStackIdentity;
  readonly assessmentStackSha256: string;
  readonly prompt: {
    readonly locator: string;
    readonly contentSha256: string;
  };
  readonly stackDescriptor: {
    readonly locator: string;
    readonly contentSha256: string;
  };
  readonly assessmentSchema: {
    readonly locator: string;
    readonly contentSha256: string;
  };
  readonly assessmentTarget: string;
  readonly shadowReportTarget: string;
}

type LedgerEvent = Readonly<{
  schemaVersion: typeof SHADOW_LEDGER_EVENT_SCHEMA_VERSION;
  kind: "assessment_requested" | "shadow_started" | "entry_terminal";
  runId: string;
  revisionId: string;
  requestSequence: number;
  continuationNonce: string | null;
  requestSha256: string | null;
  terminalState: "observed" | "failed" | "deferred_by_cap" | null;
  failurePhase: "capture" | "assessment" | "shadow" | null;
  detail: string;
  observationCount: number;
  recordedAt: string;
}>;

export type ShadowBatchAdvanceResult =
  | Readonly<{ status: "awaiting_assessment"; request: ShadowAssessmentRequest; requestPath: string }>
  | Readonly<{
    status: "complete";
    manifest: SealedShadowBatchManifest;
    manifestPath: string;
  }>;

export interface PrepareNextShadowEntryInput {
  readonly dispositionHistory?: typeof dispositionHistory;
  readonly prepared: PreparedShadowBatchState;
  readonly repoRoot: string;
  readonly captureSnapshot: (input: {
    readonly candidateLocator: string;
    readonly snapshotLocator: string;
    readonly existenceRecordLocator: string;
  }) => void;
  readonly promptLocator?: string;
  readonly stackLocator?: string;
  readonly assessmentSchemaLocator?: string;
  readonly now?: Date;
}

export interface CollectAdvanceShadowEntryInput extends PrepareNextShadowEntryInput {
  readonly request: ShadowAssessmentRequest;
  readonly runShadow?: (
    input: IntakeShadowRunInput,
    missingSourceFingerprints: readonly string[],
  ) => IntakeShadowRunResult;
}

function safeRunId(value: string): string {
  if (!/^(?=.{1,128}$)(?=.*[^.])[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error("runId must be a safe non-empty identifier.");
  }
  return value;
}

function repoPath(repoRoot: string, locatorValue: string, context: string): string {
  if (typeof locatorValue !== "string" || locatorValue === "" || locatorValue.includes("\\") ||
      !/^[A-Za-z0-9._@+%/-]+$/.test(locatorValue) ||
      locatorValue.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${context} must be a safe repository-relative artifact locator.`);
  }
  const locator = locatorValue;
  const root = resolve(repoRoot);
  const path = resolve(root, locator);
  const fromRoot = relative(root, path);
  if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error(`${context} must stay inside the repository.`);
  }
  return path;
}

function readRegularBytes(path: string, context: string, kind: ShadowStorageKind): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${context} must be a non-link regular file.`);
  assertShadowStorageSize(kind, stat.size);
  return readFileSync(path);
}

function writeOnceBytes(path: string, bytes: Buffer, kind: ShadowStorageKind): void {
  assertShadowStorageSize(kind, bytes.byteLength);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink() || !readFileSync(path).equals(bytes)) {
      throw new Error(`Immutable artifact ${path} already exists with different or untrusted bytes.`);
    }
    return;
  }
  const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY |
    (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeAllSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function runBaseLocator(runId: string): string {
  return `artifacts/github-issue-roadmap/shadow-runs/${safeRunId(runId)}`;
}

function ledgerPath(repoRoot: string, runId: string): string {
  return repoPath(repoRoot, `${runBaseLocator(runId)}/ledger.jsonl`, "shadow ledger locator");
}

function entryBaseLocator(entry: ShadowBatchEntry, sequence: number, runId: string): string {
  return `${runBaseLocator(runId)}/entries/${String(sequence).padStart(4, "0")}-${entry.revisionId}`;
}

function entryExistenceRecordLocator(entry: ShadowBatchEntry, sequence: number, runId: string): string {
  return `${entryBaseLocator(entry, sequence, runId)}/existence-record.json`;
}

function sha256Bytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseExistenceRecordBytes(bytes: Buffer): ExistenceRecordV1 {
  try {
    return parseExistenceRecord(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    throw new Error(`Host-local existence record is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readHostLocalExistenceRecord(
  repoRoot: string,
  locator: string,
): { readonly record: ExistenceRecordV1; readonly fileSha256: string } {
  const path = repoPath(repoRoot, locator, "host-local existence record locator");
  if (!existsSync(path)) throw new Error("Host-local existence record is missing.");
  const bytes = readRegularBytes(path, "Host-local existence record", "durable_run");
  return { record: parseExistenceRecordBytes(bytes), fileSha256: sha256Bytes(bytes) };
}

type VerifiedExistenceRecordInput = ExistenceRecordV1 | Readonly<{
  kind: "existence_read_failure" | "existence_write_failure";
  detail: string;
}>;

function citationVerificationAttestation(clauses: readonly ExistenceClause[]) {
  return {
    scope: ["trusted-checkout citation verification"],
    budgetConsumed: clauses.length,
    clausesEvaluated: clauses.length,
    clausesTotal: clauses.length,
  };
}

function verifyExistenceRecordCitations(
  repoRoot: string,
  record: ExistenceRecordV1,
  activeFingerprints: ReadonlySet<string>,
): VerifiedExistenceRecordInput {
  try {
    const entries = record.entries.filter(entry => activeFingerprints.has(entry.sourceFingerprint)).map((entry): ExistenceEntryInput => {
      if ("runOutcome" in entry || entry.state === "not_demonstrated") return entry;
      const clauses = entry.state === "demonstrated"
        ? entry.evidence.satisfiedClauses
        : entry.evidence.clauses;
      const verifiedClauses = clauses.map((clause): ExistenceClause => {
        if (!clause.satisfied) return clause;
        const path = repoPath(repoRoot, clause.citation.sourceLocator, "existence citation source locator");
        if (!existsSync(path)) return { clause: clause.clause, satisfied: false };
        const contents = readRegularBytes(path, "Existence citation source", "durable_run");
        return existenceCitationMatchesContent(clause.citation, contents)
          ? clause
          : { clause: clause.clause, satisfied: false };
      });
      const identity = {
        sourceFingerprint: entry.sourceFingerprint,
        emissionContentSha256: entry.emissionContentSha256,
      };
      const satisfiedCount = verifiedClauses.filter((clause) => clause.satisfied).length;
      if (satisfiedCount === verifiedClauses.length && entry.state === "demonstrated") return entry;
      if (satisfiedCount > 0) {
        return { ...identity, evidence: { clauses: verifiedClauses } };
      }
      return {
        ...identity,
        evidence: {
          clauses: verifiedClauses,
          searchAttestation: citationVerificationAttestation(verifiedClauses),
        },
      };
    });
    return createExistenceRecord({
      repository: record.repository,
      originMainSha: record.originMainSha,
      generatedAt: record.generatedAt,
      entries,
    });
  } catch (error) {
    return {
      kind: "existence_read_failure",
      detail: `Citation verification could not run: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function shadowContinuationNonce(input: {
  readonly runId: string;
  readonly revisionId: string;
  readonly requestSequence: number;
  readonly envelopeSha256: string;
  readonly snapshotContentSha256: string;
  readonly existenceRecordContentSha256: string;
  readonly existenceRecordFileSha256: string;
  readonly verifiedOriginMainSha: string;
  readonly assessmentStackSha256: string;
}): string {
  return canonicalJsonSha256(input);
}

function requestWithoutHash(request: ShadowAssessmentRequest): Omit<ShadowAssessmentRequest, "requestSha256"> {
  const copy: Record<string, unknown> = { ...request };
  delete copy.requestSha256;
  return copy as unknown as Omit<ShadowAssessmentRequest, "requestSha256">;
}

function stackIdentityFromDescriptor(descriptor: {
  readonly provider: string;
  readonly model: string;
  readonly promptSha256: string;
  readonly rubricSha256: string;
  readonly toolchainSha256: string;
  readonly calibrationRelease: string;
}): AssessmentStackIdentity {
  return {
    provider: descriptor.provider,
    model: descriptor.model,
    promptSha256: descriptor.promptSha256,
    rubricSha256: descriptor.rubricSha256,
    toolchainSha256: descriptor.toolchainSha256,
    calibrationRelease: descriptor.calibrationRelease,
  };
}

function requestIdentity(request: ShadowAssessmentRequest): string {
  return canonicalJsonSha256(requestWithoutHash(request));
}

function ledgerEvent(input: Omit<LedgerEvent, "schemaVersion" | "recordedAt">, recordedAt: string): LedgerEvent {
  return {
    schemaVersion: SHADOW_LEDGER_EVENT_SCHEMA_VERSION,
    ...input,
    recordedAt: isoTimestamp(recordedAt, "ledger event recordedAt"),
  };
}

function eventTimestamp(now?: Date): string {
  const value = now ?? new Date();
  if (!Number.isFinite(value.getTime())) throw new Error("Shadow batch event clock must be a valid date.");
  return value.toISOString();
}

function readLedger(repoRoot: string, runId: string): LedgerEvent[] {
  const path = ledgerPath(repoRoot, runId);
  if (!existsSync(path)) return [];
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Shadow ledger must be a non-link regular file.");
  assertShadowStorageSize("scratch_root", stat.size);
  const text = readFileSync(path, "utf8");
  if (text !== "" && !text.endsWith("\n")) throw new Error("Shadow ledger ends with a partial event.");
  return text.split("\n").filter(Boolean).map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      throw new Error(`Shadow ledger event ${index + 1} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Shadow ledger event ${index + 1} must be an object.`);
    }
    const raw = value as Record<string, unknown>;
    const expectedKeys = [
      "schemaVersion", "kind", "runId", "revisionId", "requestSequence", "continuationNonce",
      "requestSha256", "terminalState", "failurePhase", "detail", "observationCount", "recordedAt",
    ].sort();
    if (JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify(expectedKeys)) {
      throw new Error(`Shadow ledger event ${index + 1} has an open or incomplete shape.`);
    }
    const kind = String(raw.kind) as LedgerEvent["kind"];
    const terminalState = raw.terminalState;
    const failurePhase = raw.failurePhase;
    const continuationNonce = raw.continuationNonce;
    const requestSha256 = raw.requestSha256;
    if (raw.schemaVersion !== SHADOW_LEDGER_EVENT_SCHEMA_VERSION ||
        !["assessment_requested", "shadow_started", "entry_terminal"].includes(kind) ||
        raw.runId !== runId || typeof raw.revisionId !== "string" ||
        !Number.isSafeInteger(raw.requestSequence) || (raw.requestSequence as number) <= 0 ||
        typeof raw.detail !== "string" || !Number.isSafeInteger(raw.observationCount) ||
        (raw.observationCount as number) < 0 || typeof raw.recordedAt !== "string" ||
        !(continuationNonce === null || typeof continuationNonce === "string") ||
        !(requestSha256 === null || typeof requestSha256 === "string") ||
        ![null, "observed", "failed", "deferred_by_cap"].includes(terminalState as null | string) ||
        ![null, "capture", "assessment", "shadow"].includes(failurePhase as null | string)) {
      throw new Error(`Shadow ledger event ${index + 1} is invalid.`);
    }
    sha256(raw.revisionId, `shadow ledger event ${index + 1}.revisionId`);
    if (continuationNonce !== null) sha256(continuationNonce, `shadow ledger event ${index + 1}.continuationNonce`);
    if (requestSha256 !== null) sha256(requestSha256, `shadow ledger event ${index + 1}.requestSha256`);
    const requestedOrStarted = kind === "assessment_requested" || kind === "shadow_started";
    if (requestedOrStarted && (continuationNonce === null || requestSha256 === null ||
        terminalState !== null || failurePhase !== null)) {
      throw new Error(`Shadow ledger event ${index + 1} has invalid request/start bindings.`);
    }
    if (kind === "entry_terminal" && !hasValidTerminalBindings(
      terminalState,
      failurePhase,
      continuationNonce,
      requestSha256,
    )) {
      throw new Error(`Shadow ledger event ${index + 1} has invalid terminal bindings.`);
    }
    isoTimestamp(raw.recordedAt, `shadow ledger event ${index + 1}.recordedAt`);
    return raw as unknown as LedgerEvent;
  });
}

function hasValidTerminalBindings(
  terminalState: unknown,
  failurePhase: unknown,
  continuationNonce: unknown,
  requestSha256: unknown,
): boolean {
  if (terminalState === "deferred_by_cap") {
    return failurePhase === null && continuationNonce === null && requestSha256 === null;
  }
  if (terminalState === "observed") {
    return failurePhase === null && continuationNonce !== null && requestSha256 !== null;
  }
  if (terminalState !== "failed" || failurePhase === null) return false;
  if (failurePhase === "capture") return continuationNonce === null && requestSha256 === null;
  return continuationNonce !== null && requestSha256 !== null;
}

function appendLedger(repoRoot: string, runId: string, event: LedgerEvent): void {
  const path = ledgerPath(repoRoot, runId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendShadowBatchLedgerEvent(path, event);
}

function terminalEvents(events: readonly LedgerEvent[]): ShadowBatchTerminalEvent[] {
  return events.flatMap((event): ShadowBatchTerminalEvent[] =>
    event.kind === "entry_terminal" && event.terminalState !== null
      ? [{ revisionId: event.revisionId, terminalState: event.terminalState }]
      : []);
}

function selectedEntries(prepared: PreparedShadowBatchState): ShadowBatchEntry[] {
  return prepared.entries.filter(({ selected }) => selected);
}

function validateLedgerSequence(prepared: PreparedShadowBatchState, events: readonly LedgerEvent[]): void {
  const selected = selectedEntries(prepared);
  const states = new Map<string, "none" | "requested" | "started" | "terminal">(
    selected.map((entry) => [entry.revisionId, "none"]),
  );
  for (const event of events) {
    const entry = selected[event.requestSequence - 1];
    if (entry === undefined || entry.revisionId !== event.revisionId) {
      throw new Error("Shadow ledger event addresses an unselected or out-of-order revision.");
    }
    const state = states.get(entry.revisionId)!;
    if (event.kind === "assessment_requested") {
      if (state !== "none") throw new Error("Shadow ledger contains a duplicate assessment request.");
      states.set(entry.revisionId, "requested");
    } else if (event.kind === "shadow_started") {
      if (state !== "requested") throw new Error("Shadow ledger start event is replayed or out of order.");
      states.set(entry.revisionId, "started");
    } else {
      const terminalWithoutRequest = event.failurePhase === "capture" || event.terminalState === "deferred_by_cap";
      if (state === "terminal" || (terminalWithoutRequest ? state !== "none" : state === "none")) {
        throw new Error("Shadow ledger terminal event is duplicate or out of order.");
      }
      states.set(entry.revisionId, "terminal");
    }
  }
  let openSequenceSeen = false;
  for (const entry of selected) {
    const state = states.get(entry.revisionId)!;
    if (openSequenceSeen && state !== "none") {
      throw new Error("Shadow ledger skips an earlier non-terminal entry.");
    }
    if (state !== "terminal") openSequenceSeen = true;
  }
}

function finishIfComplete(
  prepared: PreparedShadowBatchState,
  repoRoot: string,
  events: readonly LedgerEvent[],
): ShadowBatchAdvanceResult | null {
  const terminals = terminalEvents(events);
  if (terminals.length !== selectedEntries(prepared).length) return null;
  const manifest = sealShadowBatchManifest(prepared, terminals);
  const locator = `${runBaseLocator(prepared.runId)}/collection-manifest.json`;
  const path = repoPath(repoRoot, locator, "collection manifest locator");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeOnceCanonicalJson(path, manifest);
  return { status: "complete", manifest, manifestPath: path };
}

export function parseShadowAssessmentRequest(value: unknown): ShadowAssessmentRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Assessment request must be an object.");
  }
  const raw = value as unknown as ShadowAssessmentRequest;
  const keys = [
    "schemaVersion", "requestSha256", "state", "runId", "revisionId", "requestSequence",
    "continuationNonce", "envelopeSha256", "archivedCandidate", "candidates", "intakeSnapshot",
    "assessmentStack", "assessmentStackSha256", "prompt", "stackDescriptor", "assessmentSchema",
    "assessmentTarget", "shadowReportTarget",
  ].sort();
  if (raw.skipped !== undefined) keys.push("skipped");
  const exact = (child: unknown, expected: readonly string[], context: string): void => {
    if (child === null || typeof child !== "object" || Array.isArray(child) ||
        JSON.stringify(Object.keys(child).sort()) !== JSON.stringify([...expected].sort())) {
      throw new Error(`${context} must contain its exact closed key set.`);
    }
  };
  exact(value, keys, "Assessment request");
  exact(raw.archivedCandidate, ["locator", "contentSha256"], "Assessment request archivedCandidate");
  exact(raw.intakeSnapshot, ["locator", "contentSha256", "fileSha256", "coverageSha256"], "Assessment request intakeSnapshot");
  exact(raw.assessmentStack, [
    "provider", "model", "promptSha256", "rubricSha256", "toolchainSha256", "calibrationRelease",
  ], "Assessment request assessmentStack");
  exact(raw.prompt, ["locator", "contentSha256"], "Assessment request prompt");
  exact(raw.stackDescriptor, ["locator", "contentSha256"], "Assessment request stackDescriptor");
  exact(raw.assessmentSchema, ["locator", "contentSha256"], "Assessment request assessmentSchema");
  if (!Array.isArray(raw.candidates) || raw.candidates.length === 0) {
    throw new Error("Assessment request candidates must be a non-empty array.");
  }
  raw.candidates.forEach((candidate, index) => exact(
    candidate, ["sourceFingerprint", "emissionContentSha256"], `Assessment request candidates[${index}]`,
  ));
  if (raw.schemaVersion !== SHADOW_ASSESSMENT_REQUEST_SCHEMA_VERSION || raw.state !== "awaiting_assessment" ||
      safeRunId(raw.runId) !== raw.runId || sha256(raw.revisionId, "request.revisionId") !== raw.revisionId ||
      !Number.isSafeInteger(raw.requestSequence) || raw.requestSequence <= 0 ||
      sha256(raw.continuationNonce, "request.continuationNonce") !== raw.continuationNonce ||
      sha256(raw.envelopeSha256, "request.envelopeSha256") !== raw.envelopeSha256 ||
      sha256(raw.archivedCandidate.contentSha256, "request.archivedCandidate.contentSha256") !== raw.archivedCandidate.contentSha256 ||
      sha256(raw.intakeSnapshot.contentSha256, "request.intakeSnapshot.contentSha256") !== raw.intakeSnapshot.contentSha256 ||
      sha256(raw.intakeSnapshot.fileSha256, "request.intakeSnapshot.fileSha256") !== raw.intakeSnapshot.fileSha256 ||
      sha256(raw.intakeSnapshot.coverageSha256, "request.intakeSnapshot.coverageSha256") !== raw.intakeSnapshot.coverageSha256 ||
      sha256(raw.assessmentStackSha256, "request.assessmentStackSha256") !== raw.assessmentStackSha256 ||
      sha256(raw.prompt.contentSha256, "request.prompt.contentSha256") !== raw.prompt.contentSha256 ||
      sha256(raw.stackDescriptor.contentSha256, "request.stackDescriptor.contentSha256") !== raw.stackDescriptor.contentSha256 ||
      sha256(raw.assessmentSchema.contentSha256, "request.assessmentSchema.contentSha256") !== raw.assessmentSchema.contentSha256 ||
      raw.requestSha256 !== requestIdentity(raw)) {
    throw new Error("Assessment request identity is invalid.");
  }
  validateSafeSourceLocator(raw.archivedCandidate.locator, "request.archivedCandidate.locator");
  validateSafeSourceLocator(raw.intakeSnapshot.locator, "request.intakeSnapshot.locator");
  validateSafeSourceLocator(raw.prompt.locator, "request.prompt.locator");
  validateSafeSourceLocator(raw.stackDescriptor.locator, "request.stackDescriptor.locator");
  validateSafeSourceLocator(raw.assessmentSchema.locator, "request.assessmentSchema.locator");
  validateSafeSourceLocator(raw.assessmentTarget, "request.assessmentTarget");
  validateSafeSourceLocator(raw.shadowReportTarget, "request.shadowReportTarget");
  sortedFingerprints(raw.candidates.map(({ sourceFingerprint }) => sourceFingerprint), "request.candidates.sourceFingerprints");
  raw.candidates.forEach(({ emissionContentSha256 }, index) =>
    sha256(emissionContentSha256, `request.candidates[${index}].emissionContentSha256`));
  return raw;
}

function readRequest(path: string): ShadowAssessmentRequest {
  return parseShadowAssessmentRequest(
    JSON.parse(readRegularBytes(path, "Assessment request", "durable_run").toString("utf8")),
  );
}

function terminalForFailure(input: {
  readonly prepared: PreparedShadowBatchState;
  readonly repoRoot: string;
  readonly entry: ShadowBatchEntry;
  readonly sequence: number;
  readonly request?: ShadowAssessmentRequest;
  readonly phase: "capture" | "assessment" | "shadow";
  readonly detail: string;
  readonly observationCount?: number;
  readonly recordedAt?: Date;
}): void {
  appendLedger(input.repoRoot, input.prepared.runId, ledgerEvent({
    kind: "entry_terminal",
    runId: input.prepared.runId,
    revisionId: input.entry.revisionId,
    requestSequence: input.sequence,
    continuationNonce: input.request?.continuationNonce ?? null,
    requestSha256: input.request?.requestSha256 ?? null,
    terminalState: "failed",
    failurePhase: input.phase,
    detail: input.detail,
    observationCount: input.observationCount ?? 0,
  }, eventTimestamp(input.recordedAt)));
}

function isRetryableCaptureDependencyFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /"code"\s*:\s*"(?:dependency_timeout|rate_limited)"/.test(message);
}

function deferUntouchedEntriesAfterDeadline(input: {
  readonly prepared: PreparedShadowBatchState;
  readonly repoRoot: string;
  readonly entries: readonly ShadowBatchEntry[];
  readonly firstIndex: number;
  readonly events: readonly LedgerEvent[];
  readonly recordedAt?: Date;
}): void {
  for (let index = input.firstIndex; index < input.entries.length; index += 1) {
    const entry = input.entries[index];
    if (input.events.some((event) => event.revisionId === entry.revisionId)) continue;
    appendLedger(input.repoRoot, input.prepared.runId, ledgerEvent({
      kind: "entry_terminal",
      runId: input.prepared.runId,
      revisionId: entry.revisionId,
      requestSequence: index + 1,
      continuationNonce: null,
      requestSha256: null,
      terminalState: "deferred_by_cap",
      failurePhase: null,
      detail: `Entry was not started before the immutable ${input.prepared.startDeadlineAt} deadline.`,
      observationCount: 0,
    }, eventTimestamp(input.recordedAt)));
  }
}

export function prepareNextShadowEntry(input: PrepareNextShadowEntryInput): ShadowBatchAdvanceResult {
  const { prepared, repoRoot } = input;
  if (prepared.phase !== "prepared") throw new Error("prepare-next requires prepared batch state.");
  safeRunId(prepared.runId);
  const startDeadlineAt = isoTimestamp(prepared.startDeadlineAt, "prepared.startDeadlineAt");
  if (startDeadlineAt !== prepared.startDeadlineAt) {
    throw new Error("prepared.startDeadlineAt must be a canonical immutable timestamp.");
  }
  let events = readLedger(repoRoot, prepared.runId);
  validateLedgerSequence(prepared, events);
  const completed = finishIfComplete(prepared, repoRoot, events);
  if (completed !== null) return completed;
  const history = (input.dispositionHistory ?? dispositionHistory)(prepared.trustedMainSha, { repoRoot });
  const selected = selectedEntries(prepared);

  for (let index = 0; index < selected.length; index += 1) {
    const entry = selected[index];
    const sequence = index + 1;
    if (events.some((event) => event.kind === "entry_terminal" && event.revisionId === entry.revisionId)) continue;
    const priorRequest = events.find((event) =>
      event.kind === "assessment_requested" && event.revisionId === entry.revisionId);
    const base = entryBaseLocator(entry, sequence, prepared.runId);
    const requestLocator = `${base}/assessment-request.json`;
    const requestPath = repoPath(repoRoot, requestLocator, "assessment request locator");
    if (priorRequest !== undefined) {
      const request = readRequest(requestPath);
      if (request.requestSha256 !== priorRequest.requestSha256 ||
          request.continuationNonce !== priorRequest.continuationNonce) {
        throw new Error("Persisted assessment request disagrees with the append-only ledger.");
      }
      return { status: "awaiting_assessment", request, requestPath };
    }

    const startClock = input.now ?? new Date();
    if (!Number.isFinite(startClock.getTime())) throw new Error("Shadow batch start clock must be a valid date.");
    if (startClock.getTime() >= Date.parse(startDeadlineAt)) {
      deferUntouchedEntriesAfterDeadline({
        prepared,
        repoRoot,
        entries: selected,
        firstIndex: index,
        events,
        recordedAt: startClock,
      });
      events = readLedger(repoRoot, prepared.runId);
      validateLedgerSequence(prepared, events);
      const sealed = finishIfComplete(prepared, repoRoot, events);
      if (sealed === null) throw new Error("Deadline deferral did not create complete terminal accounting.");
      return sealed;
    }

    const sourcePath = repoPath(repoRoot, entry.candidateLocator, "candidate sidecar locator");
    const candidateBytes = readRegularBytes(sourcePath, "Candidate sidecar", "durable_run");
    const envelope = parseOutcomeEnvelope(JSON.parse(candidateBytes.toString("utf8")));
    if (canonicalJsonSha256(envelope) !== entry.envelopeSha256) {
      throw new Error(`Candidate sidecar ${entry.candidateLocator} changed after discovery; immutable revision identity is invalid.`);
    }
    const selection = effectiveOutcomeCandidates(envelope, history);
    const fingerprints = selection.active.map(({ sourceFingerprint }) => sourceFingerprint).sort();
    if (JSON.stringify(fingerprints) !== JSON.stringify(entry.sourceFingerprints)) {
      throw new Error("Archived candidate fingerprint set disagrees with prepared revision identity.");
    }
    const archivedCandidateLocator = `${base}/candidate-envelope.json`;
    writeOnceBytes(repoPath(repoRoot, archivedCandidateLocator, "archived candidate locator"), candidateBytes, "durable_run");

    const promptSourceLocator = input.promptLocator ?? DEFAULT_ASSESSMENT_PROMPT_LOCATOR;
    const stackSourceLocator = input.stackLocator ?? DEFAULT_ASSESSMENT_STACK_LOCATOR;
    const schemaSourceLocator = input.assessmentSchemaLocator ?? DEFAULT_ASSESSMENT_SCHEMA_LOCATOR;
    const promptBytes = readRegularBytes(
      repoPath(repoRoot, promptSourceLocator, "assessment prompt locator"), "Assessment prompt", "string",
    );
    const stackBytes = readRegularBytes(
      repoPath(repoRoot, stackSourceLocator, "assessment stack locator"), "Assessment stack", "string",
    );
    const schemaBytes = readRegularBytes(
      repoPath(repoRoot, schemaSourceLocator, "assessment schema locator"), "Assessment schema", "string",
    );
    const descriptor = parseAssessmentStackDescriptor(
      JSON.parse(stackBytes.toString("utf8")), promptBytes.toString("utf8"), promptSourceLocator,
    );
    const assessmentStack = stackIdentityFromDescriptor(descriptor);
    const archivedPromptLocator = `${base}/assessment-prompt.md`;
    const archivedStackLocator = `${base}/assessment-stack.json`;
    const archivedSchemaLocator = `${base}/assessment-schema.json`;
    writeOnceBytes(repoPath(repoRoot, archivedPromptLocator, "archived prompt locator"), promptBytes, "string");
    writeOnceBytes(repoPath(repoRoot, archivedStackLocator, "archived stack locator"), stackBytes, "string");
    writeOnceBytes(repoPath(repoRoot, archivedSchemaLocator, "archived schema locator"), schemaBytes, "string");

    const snapshotLocator = `${base}/intake-snapshot.json`;
    const existenceRecordLocator = entryExistenceRecordLocator(entry, sequence, prepared.runId);
    try {
      input.captureSnapshot({ candidateLocator: archivedCandidateLocator, snapshotLocator, existenceRecordLocator });
    } catch (error) {
      if (!isRetryableCaptureDependencyFailure(error)) throw error;
      terminalForFailure({
        prepared, repoRoot, entry, sequence, phase: "capture",
        detail: error instanceof Error ? error.message : String(error), recordedAt: input.now,
      });
      events = readLedger(repoRoot, prepared.runId);
      validateLedgerSequence(prepared, events);
      continue;
    }
    const snapshotBytes = readRegularBytes(
      repoPath(repoRoot, snapshotLocator, "intake snapshot locator"), "Intake snapshot", "intake_snapshot",
    );
    const snapshot = parseIntakeSnapshotV1(JSON.parse(snapshotBytes.toString("utf8")));
    if (snapshot.candidateSha256 !== entry.envelopeSha256) {
      throw new Error("Captured intake snapshot is not bound to the archived envelope revision.");
    }
    const capturedExistence = readHostLocalExistenceRecord(repoRoot, existenceRecordLocator);
    if (capturedExistence.record.originMainSha !== prepared.trustedMainSha) {
      throw new Error("Host-local existence record origin/main SHA differs from the prepared trusted main SHA.");
    }
    const assessmentStackHash = assessmentStackSha256(assessmentStack);
    const continuationNonce = shadowContinuationNonce({
      runId: prepared.runId,
      revisionId: entry.revisionId,
      requestSequence: sequence,
      envelopeSha256: entry.envelopeSha256,
      snapshotContentSha256: snapshot.contentSha256,
      existenceRecordContentSha256: capturedExistence.record.contentSha256,
      existenceRecordFileSha256: capturedExistence.fileSha256,
      verifiedOriginMainSha: prepared.trustedMainSha,
      assessmentStackSha256: assessmentStackHash,
    });
    const withoutHash: Omit<ShadowAssessmentRequest, "requestSha256"> = {
      schemaVersion: SHADOW_ASSESSMENT_REQUEST_SCHEMA_VERSION,
      state: "awaiting_assessment",
      runId: prepared.runId,
      revisionId: entry.revisionId,
      requestSequence: sequence,
      continuationNonce,
      envelopeSha256: entry.envelopeSha256,
      archivedCandidate: { locator: archivedCandidateLocator, contentSha256: sha256Bytes(candidateBytes) },
      skipped: intakeDispositionSkips(envelope, history),
      candidates: selection.active.map(({ sourceFingerprint, emissionContentSha256 }) => ({
        sourceFingerprint, emissionContentSha256,
      })).sort((left, right) => left.sourceFingerprint.localeCompare(right.sourceFingerprint, "en")),
      intakeSnapshot: {
        locator: snapshotLocator,
        contentSha256: snapshot.contentSha256,
        fileSha256: sha256Bytes(snapshotBytes),
        coverageSha256: intakeSnapshotCoverageSha256(snapshot),
      },
      assessmentStack,
      assessmentStackSha256: assessmentStackHash,
      prompt: { locator: archivedPromptLocator, contentSha256: sha256Bytes(promptBytes) },
      stackDescriptor: { locator: archivedStackLocator, contentSha256: sha256Bytes(stackBytes) },
      assessmentSchema: { locator: archivedSchemaLocator, contentSha256: sha256Bytes(schemaBytes) },
      assessmentTarget: `${base}/assessment.json`,
      shadowReportTarget: `${base}/shadow-report.json`,
    };
    const request: ShadowAssessmentRequest = { ...withoutHash, requestSha256: canonicalJsonSha256(withoutHash) };
    mkdirSync(dirname(requestPath), { recursive: true, mode: 0o700 });
    writeOnceCanonicalJson(requestPath, request);
    appendLedger(repoRoot, prepared.runId, ledgerEvent({
      kind: "assessment_requested", runId: prepared.runId, revisionId: entry.revisionId,
      requestSequence: sequence, continuationNonce, requestSha256: request.requestSha256,
      terminalState: null, failurePhase: null, detail: "Immutable assessment request emitted.", observationCount: 0,
    }, eventTimestamp(input.now)));
    return { status: "awaiting_assessment", request, requestPath };
  }
  events = readLedger(repoRoot, prepared.runId);
  validateLedgerSequence(prepared, events);
  const result = finishIfComplete(prepared, repoRoot, events);
  if (result === null) throw new Error("Batch has no requestable entry but is missing terminal accounting.");
  return result;
}

function loadBoundRequestEvidence(input: {
  readonly dispositionHistory: DispositionHistory;
  readonly repoRoot: string;
  readonly request: ShadowAssessmentRequest;
  readonly existenceRecord: VerifiedExistenceRecordInput;
  readonly existenceRecordGeneratedAt: string;
  readonly verifiedOriginMainSha: string;
}): {
  readonly envelope: OutcomeEnvelope;
  readonly snapshot: IntakeSnapshotV1;
  readonly existenceRecord: VerifiedExistenceRecordInput;
  readonly existenceRecordGeneratedAt: string;
  readonly verifiedOriginMainSha: string;
  readonly stack: AssessmentStackIdentity;
} {
  const candidateBytes = readRegularBytes(
    repoPath(input.repoRoot, input.request.archivedCandidate.locator, "archived candidate locator"),
    "Archived candidate", "durable_run",
  );
  const envelope = parseOutcomeEnvelope(JSON.parse(candidateBytes.toString("utf8")));
  if (canonicalJsonSha256(envelope) !== input.request.envelopeSha256 ||
      sha256Bytes(candidateBytes) !== input.request.archivedCandidate.contentSha256) {
    throw new Error("Archived candidate envelope or byte hash does not match the assessment request.");
  }
  const snapshotBytes = readRegularBytes(
    repoPath(input.repoRoot, input.request.intakeSnapshot.locator, "intake snapshot locator"),
    "Intake snapshot", "intake_snapshot",
  );
  const snapshot = parseIntakeSnapshotV1(JSON.parse(snapshotBytes.toString("utf8")));
  if (snapshot.contentSha256 !== input.request.intakeSnapshot.contentSha256 ||
      sha256Bytes(snapshotBytes) !== input.request.intakeSnapshot.fileSha256 ||
      intakeSnapshotCoverageSha256(snapshot) !== input.request.intakeSnapshot.coverageSha256 ||
      snapshot.candidateSha256 !== input.request.envelopeSha256) {
    throw new Error("Intake snapshot hash, coverage, or candidate binding does not match the request.");
  }
  const promptBytes = readRegularBytes(
    repoPath(input.repoRoot, input.request.prompt.locator, "archived prompt locator"),
    "Archived assessment prompt", "string",
  );
  const stackBytes = readRegularBytes(
    repoPath(input.repoRoot, input.request.stackDescriptor.locator, "archived stack locator"),
    "Archived assessment stack", "string",
  );
  const schemaBytes = readRegularBytes(
    repoPath(input.repoRoot, input.request.assessmentSchema.locator, "archived assessment schema locator"),
    "Archived assessment schema", "string",
  );
  if (sha256Bytes(promptBytes) !== input.request.prompt.contentSha256 ||
      sha256Bytes(stackBytes) !== input.request.stackDescriptor.contentSha256 ||
      sha256Bytes(schemaBytes) !== input.request.assessmentSchema.contentSha256) {
    throw new Error("Archived assessment prompt, stack descriptor, or schema hash drifted.");
  }
  const descriptor = parseAssessmentStackDescriptor(
    JSON.parse(stackBytes.toString("utf8")), promptBytes.toString("utf8"),
  );
  const stack = stackIdentityFromDescriptor(descriptor);
  if (assessmentStackSha256(stack) !== input.request.assessmentStackSha256 ||
      canonicalJson(stack) !== canonicalJson(input.request.assessmentStack)) {
    throw new Error("Archived assessment stack does not match the request stack binding.");
  }
  const expectedCandidates = effectiveOutcomeCandidates(envelope, input.dispositionHistory).active.map(({ sourceFingerprint, emissionContentSha256 }) => ({
    sourceFingerprint, emissionContentSha256,
  })).sort((left, right) => left.sourceFingerprint.localeCompare(right.sourceFingerprint, "en"));
  if (canonicalJson(expectedCandidates) !== canonicalJson(input.request.candidates)) {
    throw new Error("Assessment request candidate set does not match the archived envelope.");
  }
  if (canonicalJson(input.request.skipped ?? []) !== canonicalJson(intakeDispositionSkips(envelope, input.dispositionHistory))) {
    throw new Error("Assessment request skipped set does not match disposition history.");
  }
  return {
    envelope,
    snapshot,
    existenceRecord: input.existenceRecord,
    existenceRecordGeneratedAt: input.existenceRecordGeneratedAt,
    verifiedOriginMainSha: input.verifiedOriginMainSha,
    stack,
  };
}

function matchingObservations(
  repoRoot: string,
  request: ShadowAssessmentRequest,
  evidence: {
    readonly envelope: OutcomeEnvelope;
    readonly snapshot: IntakeSnapshotV1;
    readonly existenceRecord: VerifiedExistenceRecordInput;
    readonly existenceRecordGeneratedAt: string;
    readonly verifiedOriginMainSha: string;
  },
  assessment: ReturnType<typeof parseIntakeAssessment>,
  history: DispositionHistory,
): IntakeObservationRecordV2[] {
  const root = resolve(repoRoot, INTAKE_OBSERVATION_DIRECTORY);
  if (!existsSync(root)) return [];
  const records = readdirSync(root).map((name) => readIntakeJournalRecord(join(root, name)));
  const related = records.flatMap((record): IntakeObservationRecordV2[] =>
    record.schemaVersion === INTAKE_OBSERVATION_SCHEMA &&
      record.candidate.contentSha256 === request.envelopeSha256 &&
      request.candidates.some(({ sourceFingerprint }) => sourceFingerprint === record.candidate.sourceFingerprint)
      ? [record]
      : []);
  const postGate = related.filter((record) =>
    Date.parse(record.observedAt) >= Date.parse(evidence.existenceRecordGeneratedAt));
  const expectedDecision = compileIntakeDecision({
    dispositionHistory: history,
    envelope: evidence.envelope,
    snapshot: evidence.snapshot,
    assessment,
    existenceRecord: evidence.existenceRecord,
    verifiedOriginMainSha: evidence.verifiedOriginMainSha,
    capabilityManifest: null,
  });
  const expectedDecisionSha256 = canonicalJsonSha256(expectedDecision);
  const expectedOperands = deriveIntakeObservationOperands({
    dispositionHistory: history,
    envelope: evidence.envelope,
    snapshot: evidence.snapshot,
    assessment,
    decision: expectedDecision,
    existenceRecord: evidence.existenceRecord,
    verifiedOriginMainSha: evidence.verifiedOriginMainSha,
  });
  for (const record of postGate) {
    const assessedCandidate = expectedDecision.candidates.find(({ sourceFingerprint }) =>
      sourceFingerprint === record.candidate.sourceFingerprint);
    if (record.candidate.locator !== request.archivedCandidate.locator ||
        record.snapshot.locator !== request.intakeSnapshot.locator ||
        record.snapshot.contentSha256 !== request.intakeSnapshot.contentSha256 ||
        record.decisionSha256 !== expectedDecisionSha256 ||
        record.assessmentSha256 !== intakeAssessmentSha256(assessment) ||
        record.assessmentStackSha256 !== request.assessmentStackSha256 ||
        record.producerKind !== evidence.envelope.producer.kind ||
        assessedCandidate === undefined || record.observedMatch !== assessedCandidate.matchResult ||
        canonicalJson({
          operandDerivationVersion: record.operandDerivationVersion,
          observedDisposition: record.observedDisposition,
          actionOperands: record.actionOperands,
        }) !== canonicalJson(expectedOperands.get(record.candidate.sourceFingerprint))) {
      throw new Error(
        "An immutable observation identity exists with different candidate, snapshot, assessment, or stack content.",
      );
    }
  }
  const fingerprints = related.map(({ candidate }) => candidate.sourceFingerprint);
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new Error("Duplicate observations exist for one assessment request candidate.");
  }
  return related;
}

function appendObservedTerminal(
  prepared: PreparedShadowBatchState,
  repoRoot: string,
  entry: ShadowBatchEntry,
  request: ShadowAssessmentRequest,
  recordedAt?: Date,
): void {
  appendLedger(repoRoot, prepared.runId, ledgerEvent({
    kind: "entry_terminal", runId: prepared.runId, revisionId: entry.revisionId,
    requestSequence: request.requestSequence, continuationNonce: request.continuationNonce,
    requestSha256: request.requestSha256, terminalState: "observed", failurePhase: null,
    detail: "Every candidate fingerprint has one bound observation.", observationCount: request.candidates.length,
  }, eventTimestamp(recordedAt)));
}

function persistProvisionalExistenceSuppressions(input: {
  readonly dispositionHistory: DispositionHistory;
  readonly repoRoot: string;
  readonly envelope: OutcomeEnvelope;
  readonly snapshot: IntakeSnapshotV1;
  readonly assessment: ReturnType<typeof parseIntakeAssessment>;
  readonly existenceRecord: ExistenceRecordV1;
  readonly verifiedOriginMainSha: string;
}): void {
  const ledgerPath = repoPath(
    input.repoRoot,
    EXISTENCE_SUPPRESSION_LEDGER_LOCATOR,
    "existence suppression ledger locator",
  );
  const activeBindings = new Set(listActiveExistenceSuppressions({
    ledgerPath,
    existenceRecord: input.existenceRecord,
  }).map((suppression) => [
    suppression.sourceFingerprint,
    suppression.emissionContentSha256,
    suppression.originMainSha,
  ].join("\0")));
  const routes = compileIntakeExistenceRoutes({
    dispositionHistory: input.dispositionHistory,
    envelope: input.envelope,
    snapshot: input.snapshot,
    assessment: input.assessment,
    existenceRecord: input.existenceRecord,
    verifiedOriginMainSha: input.verifiedOriginMainSha,
  });
  for (const { route } of routes) {
    if (route.kind !== "provisional_suppression") continue;
    const binding = [
      route.entry.sourceFingerprint,
      route.entry.emissionContentSha256,
      route.verifiedOriginMainSha,
    ].join("\0");
    if (activeBindings.has(binding)) continue;
    appendExistenceSuppression({
      ledgerPath,
      route,
      existenceRecord: input.existenceRecord,
    });
    activeBindings.add(binding);
  }
}

export function collectAdvanceShadowEntry(input: CollectAdvanceShadowEntryInput): ShadowBatchAdvanceResult {
  const { prepared, repoRoot } = input;
  const request = parseShadowAssessmentRequest(input.request);
  if (request.runId !== prepared.runId) throw new Error("Assessment request belongs to the wrong run.");
  const selected = selectedEntries(prepared);
  const entry = selected[request.requestSequence - 1];
  if (entry === undefined || entry.revisionId !== request.revisionId) {
    throw new Error("Assessment request is out of order or addresses the wrong revision.");
  }
  const trustedMainSha = gitSha(prepared.trustedMainSha, "prepared.trustedMainSha");
  const existenceRecordLocator = entryExistenceRecordLocator(
    entry,
    request.requestSequence,
    prepared.runId,
  );
  const hostExistence = readHostLocalExistenceRecord(repoRoot, existenceRecordLocator);
  if (hostExistence.record.originMainSha !== trustedMainSha) {
    throw new Error("Host-local existence record origin/main SHA differs from the prepared trusted main SHA.");
  }
  const expectedNonce = shadowContinuationNonce({
    runId: prepared.runId,
    revisionId: entry.revisionId,
    requestSequence: request.requestSequence,
    envelopeSha256: request.envelopeSha256,
    snapshotContentSha256: request.intakeSnapshot.contentSha256,
    existenceRecordContentSha256: hostExistence.record.contentSha256,
    existenceRecordFileSha256: hostExistence.fileSha256,
    verifiedOriginMainSha: trustedMainSha,
    assessmentStackSha256: request.assessmentStackSha256,
  });
  if (request.continuationNonce !== expectedNonce) throw new Error("Assessment request continuation nonce is invalid.");
  if (request.requestSha256 !== requestIdentity(request)) throw new Error("Assessment request identity is invalid.");
  const persisted = readRequest(repoPath(
    repoRoot,
    `${entryBaseLocator(entry, request.requestSequence, prepared.runId)}/assessment-request.json`,
    "assessment request locator",
  ));
  if (canonicalJson(persisted) !== canonicalJson(request)) {
    throw new Error("Assessment request is stale or differs from the immutable requested bytes.");
  }
  const events = readLedger(repoRoot, prepared.runId);
  validateLedgerSequence(prepared, events);
  const requested = events.find((event) => event.kind === "assessment_requested" &&
    event.revisionId === entry.revisionId);
  if (requested === undefined || requested.requestSha256 !== request.requestSha256 ||
      requested.continuationNonce !== request.continuationNonce) {
    throw new Error("Assessment request has no matching ordered ledger event.");
  }
  if (events.some((event) => event.kind === "entry_terminal" && event.revisionId === entry.revisionId)) {
    throw new Error("Duplicate or replayed collect call addresses an already terminal entry.");
  }
  const earlierIncomplete = selected.slice(0, request.requestSequence - 1).some((candidate) =>
    !events.some((event) => event.kind === "entry_terminal" && event.revisionId === candidate.revisionId));
  if (earlierIncomplete) throw new Error("Assessment request is out of order; an earlier entry is not terminal.");

  // Refuse unavailable history before publishing any bound assessment or shadow artifacts.
  const history = (input.dispositionHistory ?? dispositionHistory)(trustedMainSha, { repoRoot });
  const verifiedExistenceRecord = verifyExistenceRecordCitations(repoRoot, hostExistence.record, new Set(request.candidates.map(({ sourceFingerprint }) => sourceFingerprint)));
  let verifiedExistenceRecordLocator = existenceRecordLocator;
  if (canonicalJson(verifiedExistenceRecord) !== canonicalJson(hostExistence.record)) {
    verifiedExistenceRecordLocator = `${entryBaseLocator(
      entry,
      request.requestSequence,
      prepared.runId,
    )}/verified-existence-record.json`;
    writeOnceBytes(
      repoPath(repoRoot, verifiedExistenceRecordLocator, "verified existence record locator"),
      Buffer.from(prettyCanonicalJson(verifiedExistenceRecord), "utf8"),
      "durable_run",
    );
  }

  const evidence = loadBoundRequestEvidence({
    dispositionHistory: history,
    repoRoot,
    request,
    existenceRecord: verifiedExistenceRecord,
    existenceRecordGeneratedAt: hostExistence.record.generatedAt,
    verifiedOriginMainSha: trustedMainSha,
  });
  let assessment: ReturnType<typeof parseIntakeAssessment>;
  const assessmentPath = repoPath(repoRoot, request.assessmentTarget, "assessment target locator");
  if (existsSync(assessmentPath)) {
    const assessmentStat = lstatSync(assessmentPath);
    if (!assessmentStat.isFile() || assessmentStat.isSymbolicLink()) {
      throw new Error("Host assessment target must be a non-link regular file.");
    }
  }
  try {
    const assessmentBytes = readRegularBytes(assessmentPath, "Host assessment", "string");
    assessment = parseIntakeAssessment(
      JSON.parse(assessmentBytes.toString("utf8")), evidence.envelope, evidence.snapshot, evidence.stack, history,
    );
    assertIntakeSnapshotFreshForShadow(evidence.snapshot, input.now ?? new Date());
  } catch (error) {
    terminalForFailure({
      prepared, repoRoot, entry, sequence: request.requestSequence, request, phase: "assessment",
      detail: error instanceof Error ? error.message : String(error), recordedAt: input.now,
    });
    return prepareNextShadowEntry(input);
  }
  if (assessmentStackSha256(assessment.stack) !== request.assessmentStackSha256) {
    throw new Error("Validated assessment stack hash does not match the request.");
  }
  const assessmentInputLocator = `${entryBaseLocator(
    entry,
    request.requestSequence,
    prepared.runId,
  )}/validated-assessment.json`;
  writeOnceBytes(
    repoPath(repoRoot, assessmentInputLocator, "validated assessment locator"),
    Buffer.from(intakeAssessmentJson(assessment), "utf8"),
    "string",
  );

  let effectiveEvidence = evidence;
  let effectiveExistenceRecordLocator = verifiedExistenceRecordLocator;
  if (!("kind" in verifiedExistenceRecord)) {
    try {
      persistProvisionalExistenceSuppressions({
        dispositionHistory: history,
        repoRoot,
        envelope: evidence.envelope,
        snapshot: evidence.snapshot,
        assessment,
        existenceRecord: verifiedExistenceRecord,
        verifiedOriginMainSha: trustedMainSha,
      });
    } catch (error) {
      const degradedExistenceRecord: VerifiedExistenceRecordInput = {
        kind: "existence_write_failure",
        detail: `Existence suppression write failed; filing is held. (${
          error instanceof Error ? error.message : String(error)
        })`,
      };
      effectiveExistenceRecordLocator = `${entryBaseLocator(
        entry,
        request.requestSequence,
        prepared.runId,
      )}/suppression-write-failure.json`;
      try {
        writeOnceBytes(
          repoPath(repoRoot, effectiveExistenceRecordLocator, "suppression write failure locator"),
          Buffer.from(prettyCanonicalJson(degradedExistenceRecord), "utf8"),
          "string",
        );
      } catch (recordingError) {
        terminalForFailure({
          prepared,
          repoRoot,
          entry,
          sequence: request.requestSequence,
          request,
          phase: "shadow",
          detail: `Existence suppression write failed and its degradation record could not be persisted; filing is held. (${
            recordingError instanceof Error ? recordingError.message : String(recordingError)
          })`,
          recordedAt: input.now,
        });
        return prepareNextShadowEntry(input);
      }
      effectiveEvidence = { ...evidence, existenceRecord: degradedExistenceRecord };
    }
  }

  const existing = matchingObservations(repoRoot, request, effectiveEvidence, assessment, history);
  if (existing.length === request.candidates.length) {
    appendObservedTerminal(prepared, repoRoot, entry, request, input.now);
    return prepareNextShadowEntry(input);
  }
  const started = events.find((event) => event.kind === "shadow_started" && event.revisionId === entry.revisionId);
  const invocationTime = started !== undefined
    ? new Date(started.recordedAt)
    : existing.length > 0
      ? new Date(existing[0].observedAt)
      : input.now;
  if (started === undefined) {
    appendLedger(repoRoot, prepared.runId, ledgerEvent({
      kind: "shadow_started", runId: prepared.runId, revisionId: entry.revisionId,
      requestSequence: request.requestSequence, continuationNonce: request.continuationNonce,
      requestSha256: request.requestSha256, terminalState: null, failurePhase: null,
      detail: "Real shadow intake invocation started.", observationCount: existing.length,
    }, eventTimestamp(invocationTime)));
  }
  const observedFingerprints = new Set(existing.map(({ candidate }) => candidate.sourceFingerprint));
  const missingSourceFingerprints = request.candidates
    .map(({ sourceFingerprint }) => sourceFingerprint)
    .filter((sourceFingerprint) => !observedFingerprints.has(sourceFingerprint));
  const requestPath = repoPath(
    repoRoot,
    `${entryBaseLocator(entry, request.requestSequence, prepared.runId)}/assessment-request.json`,
    "assessment request locator",
  );
  try {
    (input.runShadow ?? runIntakeShadow)({
      dispositionHistory: () => history,
      repoRoot,
      candidate: request.archivedCandidate.locator,
      snapshot: request.intakeSnapshot.locator,
      assessment: assessmentInputLocator,
      existence: effectiveExistenceRecordLocator,
      verifiedOriginMainSha: trustedMainSha,
      capabilities: null,
      out: request.shadowReportTarget,
      now: invocationTime,
      expectedAssessmentStack: request.assessmentStack,
      log: () => {},
    }, missingSourceFingerprints);
  } catch (error) {
    const afterFailure = matchingObservations(repoRoot, request, effectiveEvidence, assessment, history);
    if (afterFailure.length === request.candidates.length) {
      appendObservedTerminal(prepared, repoRoot, entry, request, input.now);
      return prepareNextShadowEntry(input);
    }
    if (afterFailure.length > 0) {
      return { status: "awaiting_assessment", request, requestPath };
    }
    terminalForFailure({
      prepared, repoRoot, entry, sequence: request.requestSequence, request, phase: "shadow",
      detail: error instanceof Error ? error.message : String(error), observationCount: afterFailure.length,
      recordedAt: input.now,
    });
    return prepareNextShadowEntry(input);
  }
  const observations = matchingObservations(repoRoot, request, effectiveEvidence, assessment, history);
  if (observations.length !== request.candidates.length) {
    if (observations.length > 0) {
      return { status: "awaiting_assessment", request, requestPath };
    }
    terminalForFailure({
      prepared, repoRoot, entry, sequence: request.requestSequence, request, phase: "shadow",
      detail: "Shadow intake returned without one observation per bound candidate.", observationCount: observations.length,
      recordedAt: input.now,
    });
  } else {
    appendObservedTerminal(prepared, repoRoot, entry, request, input.now);
  }
  return prepareNextShadowEntry(input);
}
