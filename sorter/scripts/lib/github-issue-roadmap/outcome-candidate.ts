import { AUTOMATIC_INTAKE_LIMITS } from "./capability-manifest";
import { canonicalJsonSha256, prettyCanonicalJson, sha256Bytes } from "./canonical-json";
import { containsSourceMarkerSentinel } from "./source-marker-sentinel";
import { AUTHORED_START_COMMANDS, type AuthoredStartCommand } from "./start-command-values";
import {
  compareCanonicalStrings,
  qualifyRepositoryIdentity,
  type RepositoryIdentityV2,
} from "./snapshot-v2";

/**
 * The approved envelope budgets, asserted on the raw JSON before any parse.
 *
 * This lives here rather than in `scripts/github-issue-roadmap-intake.ts` because shadow mode has
 * to apply the identical limits and its import closure cannot reach the CLI root (see
 * `scripts/lint-github-issue-roadmap-shadow-boundary.ts`). One definition, both entrypoints: a
 * 64 KiB envelope, a 16 KiB candidate, and a five-active-candidate envelope are refused with the
 * same message whichever path read the file. Byte limits include dispositioned candidates.
 * The CLI re-exports it so existing importers are unaffected.
 */
export function assertAutomaticIntakeEnvelopeBudgets(raw: unknown): void {
  const serialized = JSON.stringify(raw);
  if (Buffer.byteLength(serialized, "utf8") > AUTOMATIC_INTAKE_LIMITS.maxEnvelopeBytes) {
    throw new Error("Automatic intake envelope exceeds the approved 64 KiB limit.");
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Automatic intake envelope must be an object.");
  const candidates = (raw as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) throw new Error("Automatic intake envelope candidates must be an array.");
  candidates.forEach((candidate, index) => {
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > AUTOMATIC_INTAKE_LIMITS.maxCandidateBytes) {
      throw new Error(`Automatic intake candidate ${index} exceeds the approved 16 KiB limit.`);
    }
  });
  const isV2 = (raw as { schemaVersion?: unknown }).schemaVersion === OUTCOME_ENVELOPE_SCHEMA_VERSION_V2;
  const activeCount = candidates.filter((candidate, index) => {
    if (!isV2 || candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return true;
    if (!Object.hasOwn(candidate, "disposition")) return true;
    return parseDisposition(candidate.disposition, `outcome envelope.candidates[${index}].disposition`) === undefined;
  }).length;
  if (activeCount > AUTOMATIC_INTAKE_LIMITS.maxEnvelopeCandidates) throw new Error("Automatic intake accepts at most five active candidates per envelope.");
}

export const OUTCOME_ENVELOPE_SCHEMA_VERSION = "github-issue-roadmap-outcome-envelope/v1";
export const OUTCOME_ENVELOPE_SCHEMA_VERSION_V2 = "github-issue-roadmap-outcome-envelope/v2";
export const OUTCOME_ENVELOPE_SCHEMA_VERSIONS = [
  OUTCOME_ENVELOPE_SCHEMA_VERSION,
  OUTCOME_ENVELOPE_SCHEMA_VERSION_V2,
] as const;

export const PRODUCER_KINDS = [
  "plan",
  "brainstorm",
  "ideation",
  "audit",
  "implementation_discovery",
  "future_user_bug",
] as const;

export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;

export const EVIDENCE_KINDS = [
  "source_artifact",
  "repository_fact",
  "current_main_verification",
  "merged_work",
  "approved_strategy",
  "canonical_issue",
] as const;

export const RELATIONSHIP_KINDS = ["parent", "blocks", "blocked_by", "related"] as const;
export const ISSUE_TYPE_SUGGESTIONS = ["Bug", "Feature", "Task"] as const;
export const PRIORITY_SUGGESTIONS = ["P0", "P1", "P2", "P3"] as const;
export const EFFORT_SUGGESTIONS = ["Low", "Medium", "High"] as const;

export type ProducerKind = typeof PRODUCER_KINDS[number];
export type Confidence = typeof CONFIDENCE_LEVELS[number];
export type EvidenceKind = typeof EVIDENCE_KINDS[number];
export type RelationshipKind = typeof RELATIONSHIP_KINDS[number];
export type IssueTypeSuggestion = typeof ISSUE_TYPE_SUGGESTIONS[number];
export type PrioritySuggestion = typeof PRIORITY_SUGGESTIONS[number];
export type EffortSuggestion = typeof EFFORT_SUGGESTIONS[number];
export type OutcomeRepositoryIdentity = RepositoryIdentityV2;

export interface OutcomeEvidence {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly sourceLocator: string;
  readonly contentSha256: string;
}

export interface OutcomeProvenance {
  readonly id: string;
  readonly sourceLocator: string;
  readonly contentSha256: string;
}

/** Hash the exact source bytes recorded in evidence and provenance entries. */
export function outcomeSourceContentSha256(contents: Uint8Array): string {
  return sha256Bytes(contents);
}

/**
 * Compare against both the raw bytes and their LF-normalised form. Evidence hashes are
 * author-supplied in the outcome sidecar rather than derived by one producer, so there is no
 * single convention to reuse: a file that is LF on disk hashes identically either way, while a
 * CRLF checkout of an LF-hashed file only matches after normalisation. Comparing raw bytes
 * alone would report drift for every CRLF file on a Windows checkout and turn evidence
 * verification into noise. A real content change still fails both forms.
 * A match proves only that these bytes match the author-supplied, unauthenticated recorded hash.
 */
export function outcomeSourceContentMatchesSha256(
  contents: Uint8Array,
  recordedContentSha256: string,
): boolean {
  const rawContents = Buffer.from(contents);
  if (outcomeSourceContentSha256(rawContents) === recordedContentSha256) return true;
  const decodedContents = rawContents.toString("utf8");
  if (!Buffer.from(decodedContents, "utf8").equals(rawContents)) return false;
  const normalisedContents = Buffer.from(decodedContents.replace(/\r\n/g, "\n"), "utf8");
  return outcomeSourceContentSha256(normalisedContents) === recordedContentSha256;
}

export interface OutcomeReadinessSignals {
  readonly independentlyCloseable: boolean;
  readonly framingComplete: boolean;
  readonly completionRuleDefined: boolean;
  readonly evidenceSufficient: boolean;
  readonly estimationSubstrate: boolean;
  readonly unresolvedDecisionIds: readonly string[];
  readonly dependencyIds: readonly string[];
  readonly currentMainVerificationEvidenceId: string | null;
}

export interface OutcomeRelationshipCandidate {
  readonly kind: RelationshipKind;
  readonly targetIssueNumber: number;
  readonly evidenceIds: readonly string[];
}

export interface OutcomeSuggestion<T extends string> {
  readonly value: T | null;
  readonly confidence: Confidence;
  readonly rationale: string;
}

export type OutcomeDisposition =
  | {
    readonly kind: "achieved";
    readonly commits: readonly { readonly sha: string }[];
    readonly note: string;
  }
  | {
    readonly kind: "superseded";
    readonly target: {
      readonly stableArtifactId: string;
      readonly stableOutcomeId: string;
    };
    readonly note: string;
  };

export interface OutcomeCandidateMaterial {
  readonly stableOutcomeId: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly startCommand?: AuthoredStartCommand;
  readonly disposition?: OutcomeDisposition;
  readonly outcome: {
    readonly title: string;
    readonly completionRule: string;
    readonly affectedSystems: readonly string[];
  };
  readonly evidence: readonly OutcomeEvidence[];
  readonly provenance: readonly OutcomeProvenance[];
  readonly readiness: OutcomeReadinessSignals;
  readonly relationshipCandidates: readonly OutcomeRelationshipCandidate[];
  readonly suggestions: {
    readonly type: OutcomeSuggestion<IssueTypeSuggestion>;
    readonly priority: OutcomeSuggestion<PrioritySuggestion>;
    readonly effort: OutcomeSuggestion<EffortSuggestion>;
  };
}

export interface OutcomeCandidate extends OutcomeCandidateMaterial {
  readonly sourceFingerprint: string;
  readonly emissionContentSha256: string;
}

export interface OutcomeEnvelope {
  readonly schemaVersion: typeof OUTCOME_ENVELOPE_SCHEMA_VERSIONS[number];
  readonly repository: OutcomeRepositoryIdentity;
  readonly producer: {
    readonly kind: ProducerKind;
    readonly version: string;
  };
  readonly artifact: {
    readonly stableId: string;
    readonly revisionSha256: string;
    readonly sourceLocator: string;
  };
  readonly candidates: readonly OutcomeCandidate[];
}

/** Partition a parsed envelope without changing candidate order or identity. */
export function activeOutcomeCandidates(envelope: OutcomeEnvelope): {
  readonly active: readonly OutcomeCandidate[];
  readonly dispositioned: readonly OutcomeCandidate[];
} {
  const active: OutcomeCandidate[] = [];
  const dispositioned: OutcomeCandidate[] = [];
  for (const candidate of envelope.candidates) {
    (candidate.disposition === undefined ? active : dispositioned).push(candidate);
  }
  return { active, dispositioned };
}

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

export type OutcomeCandidateDraft = Mutable<OutcomeCandidateMaterial>;

export interface OutcomeEnvelopeDraft {
  schemaVersion: typeof OUTCOME_ENVELOPE_SCHEMA_VERSIONS[number];
  repository: {
    organization: string;
    name: string;
    databaseId: number;
    nodeId: string;
  };
  producer: { kind: ProducerKind; version: string };
  artifact: { stableId: string; revisionSha256: string; sourceLocator: string };
  candidates: OutcomeCandidateDraft[];
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

function nonEmptyString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${context} must be a non-empty string.`);
  }
  return value.trim().replace(/\r\n/g, "\n");
}

export function validateStableIdentifier(value: unknown, context: string): string {
  const identifier = nonEmptyString(value, context);
  if (identifier.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(identifier)) {
    throw new Error(`${context} must be a stable identifier using repository-safe characters.`);
  }
  return identifier;
}

export function validateSha256(value: unknown, context: string): string {
  const sha = nonEmptyString(value, context);
  if (!/^[0-9a-f]{64}$/i.test(sha)) throw new Error(`${context} must be a 64-character SHA-256.`);
  return sha.toLowerCase();
}

export function validateSafeSourceLocator(value: unknown, context = "source locator"): string {
  const locator = nonEmptyString(value, context);
  if (
    locator.length > 512 || locator.includes("\\") || locator.startsWith("/") ||
    /[?#\u0000-\u001f]/.test(locator) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(locator) ||
    !/^[A-Za-z0-9._@+/-]+$/.test(locator)
  ) {
    throw new Error(`${context} must be a safe repository-relative locator.`);
  }
  const segments = locator.split("/");
  if (
    segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
    segments[0].toLowerCase() === ".git"
  ) {
    throw new Error(`${context} must stay within the repository and outside .git.`);
  }
  return locator;
}

function bool(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${context} must be boolean.`);
  return value;
}

function positiveInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${context} must be a positive integer.`);
  }
  return value as number;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  context: string,
): T {
  if (!allowed.includes(value as T)) throw new Error(`${context} is unsupported.`);
  return value as T;
}

function uniqueSortedIdentifiers(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array.`);
  const identifiers = value.map((entry, index) => validateStableIdentifier(entry, `${context}[${index}]`));
  if (new Set(identifiers).size !== identifiers.length) throw new Error(`${context} contains duplicates.`);
  return identifiers.sort(compareCanonicalStrings);
}

function repository(value: unknown): OutcomeRepositoryIdentity {
  const raw = object(value, "outcome envelope.repository");
  exactKeys(raw, ["organization", "name", "databaseId", "nodeId"], "outcome envelope.repository");
  return qualifyRepositoryIdentity({
    organization: validateStableIdentifier(raw.organization, "outcome envelope.repository.organization"),
    name: validateStableIdentifier(raw.name, "outcome envelope.repository.name"),
    databaseId: positiveInteger(raw.databaseId, "outcome envelope.repository.databaseId"),
    nodeId: validateStableIdentifier(raw.nodeId, "outcome envelope.repository.nodeId"),
  });
}

function parseEvidence(value: unknown, context: string): OutcomeEvidence[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${context} must be a non-empty array.`);
  const parsed = value.map((entry, index) => {
    const itemContext = `${context}[${index}]`;
    const raw = object(entry, itemContext);
    exactKeys(raw, ["id", "kind", "sourceLocator", "contentSha256"], itemContext);
    return {
      id: validateStableIdentifier(raw.id, `${itemContext}.id`),
      kind: enumValue(raw.kind, EVIDENCE_KINDS, `${itemContext}.kind`),
      sourceLocator: validateSafeSourceLocator(raw.sourceLocator, `${itemContext}.sourceLocator`),
      contentSha256: validateSha256(raw.contentSha256, `${itemContext}.contentSha256`),
    };
  });
  if (new Set(parsed.map((entry) => entry.id)).size !== parsed.length) {
    throw new Error(`${context} contains duplicate evidence IDs.`);
  }
  return parsed.sort((left, right) => compareCanonicalStrings(left.id, right.id));
}

function parseProvenance(value: unknown, context: string): OutcomeProvenance[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${context} must be a non-empty array.`);
  const parsed = value.map((entry, index) => {
    const itemContext = `${context}[${index}]`;
    const raw = object(entry, itemContext);
    exactKeys(raw, ["id", "sourceLocator", "contentSha256"], itemContext);
    return {
      id: validateStableIdentifier(raw.id, `${itemContext}.id`),
      sourceLocator: validateSafeSourceLocator(raw.sourceLocator, `${itemContext}.sourceLocator`),
      contentSha256: validateSha256(raw.contentSha256, `${itemContext}.contentSha256`),
    };
  });
  if (new Set(parsed.map((entry) => entry.id)).size !== parsed.length) {
    throw new Error(`${context} contains duplicate provenance IDs.`);
  }
  return parsed.sort((left, right) => compareCanonicalStrings(left.id, right.id));
}

function parseReadiness(value: unknown, context: string): OutcomeReadinessSignals {
  const raw = object(value, context);
  exactKeys(raw, [
    "independentlyCloseable", "framingComplete", "completionRuleDefined", "evidenceSufficient",
    "estimationSubstrate", "unresolvedDecisionIds", "dependencyIds",
    "currentMainVerificationEvidenceId",
  ], context);
  return {
    independentlyCloseable: bool(raw.independentlyCloseable, `${context}.independentlyCloseable`),
    framingComplete: bool(raw.framingComplete, `${context}.framingComplete`),
    completionRuleDefined: bool(raw.completionRuleDefined, `${context}.completionRuleDefined`),
    evidenceSufficient: bool(raw.evidenceSufficient, `${context}.evidenceSufficient`),
    estimationSubstrate: bool(raw.estimationSubstrate, `${context}.estimationSubstrate`),
    unresolvedDecisionIds: uniqueSortedIdentifiers(raw.unresolvedDecisionIds, `${context}.unresolvedDecisionIds`),
    dependencyIds: uniqueSortedIdentifiers(raw.dependencyIds, `${context}.dependencyIds`),
    currentMainVerificationEvidenceId: raw.currentMainVerificationEvidenceId === null
      ? null
      : validateStableIdentifier(
        raw.currentMainVerificationEvidenceId,
        `${context}.currentMainVerificationEvidenceId`,
      ),
  };
}

function parseRelationships(
  value: unknown,
  evidenceIds: ReadonlySet<string>,
  context: string,
): OutcomeRelationshipCandidate[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array.`);
  const parsed = value.map((entry, index) => {
    const itemContext = `${context}[${index}]`;
    const raw = object(entry, itemContext);
    exactKeys(raw, ["kind", "targetIssueNumber", "evidenceIds"], itemContext);
    const cited = uniqueSortedIdentifiers(raw.evidenceIds, `${itemContext}.evidenceIds`);
    if (cited.length === 0) throw new Error(`${itemContext}.evidenceIds must not be empty.`);
    for (const id of cited) {
      if (!evidenceIds.has(id)) throw new Error(`${itemContext} cites unknown evidence ID ${id}.`);
    }
    return {
      kind: enumValue(raw.kind, RELATIONSHIP_KINDS, `${itemContext}.kind`),
      targetIssueNumber: positiveInteger(raw.targetIssueNumber, `${itemContext}.targetIssueNumber`),
      evidenceIds: cited,
    };
  });
  parsed.sort((left, right) =>
    left.targetIssueNumber - right.targetIssueNumber || compareCanonicalStrings(left.kind, right.kind));
  const identities = parsed.map((entry) => `${entry.targetIssueNumber}:${entry.kind}`);
  if (new Set(identities).size !== identities.length) throw new Error(`${context} contains duplicates.`);
  return parsed;
}

function parseSuggestion<T extends string>(
  value: unknown,
  allowed: readonly T[],
  context: string,
): OutcomeSuggestion<T> {
  const raw = object(value, context);
  exactKeys(raw, ["value", "confidence", "rationale"], context);
  return {
    value: raw.value === null ? null : enumValue(raw.value, allowed, `${context}.value`),
    confidence: enumValue(raw.confidence, CONFIDENCE_LEVELS, `${context}.confidence`),
    rationale: nonEmptyString(raw.rationale, `${context}.rationale`),
  };
}

function v2OptionalCandidateKeys(raw: JsonObject, schemaVersion: OutcomeEnvelope["schemaVersion"]): string[] {
  return schemaVersion === OUTCOME_ENVELOPE_SCHEMA_VERSION_V2
    ? ["acceptanceCriteria", "startCommand", "disposition"].filter((key) => Object.hasOwn(raw, key))
    : [];
}

function parseDisposition(value: unknown, context: string): OutcomeDisposition | undefined {
  if (value === undefined) return undefined;
  const raw = object(value, context);
  const kind = enumValue(raw.kind, ["achieved", "superseded"] as const, `${context}.kind`);
  exactKeys(raw, kind === "achieved" ? ["kind", "commits", "note"] : ["kind", "target", "note"], context);
  const note = nonEmptyString(raw.note, `${context}.note`);
  if (note.length > 1_000) throw new Error(`${context}.note must be at most 1000 characters.`);
  if (kind === "achieved") {
    if (!Array.isArray(raw.commits) || raw.commits.length === 0) {
      throw new Error(`${context}.commits must be a non-empty array.`);
    }
    const commits = raw.commits.map((entry, index) => {
      const itemContext = `${context}.commits[${index}]`;
      const commit = object(entry, itemContext);
      exactKeys(commit, ["sha"], itemContext);
      const sha = nonEmptyString(commit.sha, `${itemContext}.sha`);
      if (!/^[0-9a-f]{40}$/.test(sha)) {
        throw new Error(`${itemContext}.sha must be a 40-character lowercase hex commit SHA.`);
      }
      return { sha };
    });
    if (new Set(commits.map(commit => commit.sha)).size !== commits.length) {
      throw new Error(`${context}.commits contains duplicate SHAs after trimming.`);
    }
    return { kind, commits, note };
  }
  const target = object(raw.target, `${context}.target`);
  exactKeys(target, ["stableArtifactId", "stableOutcomeId"], `${context}.target`);
  return {
    kind,
    target: {
      stableArtifactId: validateStableIdentifier(target.stableArtifactId, `${context}.target.stableArtifactId`),
      stableOutcomeId: validateStableIdentifier(target.stableOutcomeId, `${context}.target.stableOutcomeId`),
    },
    note,
  };
}

function parseAcceptanceCriteria(value: unknown, context: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${context} must be an array.`);
  if (value.length > 12) throw new Error(`${context} must contain at most 12 items.`);
  const criteria = value.map((entry, index) => {
    const itemContext = `${context}[${index}]`;
    if (typeof entry !== "string") throw new Error(`${itemContext} must be a string.`);
    const text = entry.trim();
    if (text === "") throw new Error(`${itemContext} must be non-empty after trimming.`);
    if (/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/u.test(entry)) {
      throw new Error(`${itemContext} must be a single line without control or invisible characters.`);
    }
    if (text.length > 300) throw new Error(`${itemContext} must be at most 300 characters.`);
    if (/^(?:[-*+](?:\s|$)|\d+[.)](?:\s|$)|#{1,6}(?:\s|$)|\[[ xX]\])/.test(text)) {
      throw new Error(`${itemContext} must not start with a list, heading, or checkbox marker.`);
    }
    if (containsSourceMarkerSentinel(text)) {
      throw new Error(`${itemContext} must not contain an HTML comment opener or a source-marker sentinel.`);
    }
    return text;
  });
  if (new Set(criteria).size !== criteria.length) throw new Error(`${context} contains duplicates after trimming.`);
  return criteria;
}

function parseMaterial(
  value: unknown,
  context: string,
  schemaVersion: OutcomeEnvelope["schemaVersion"],
): OutcomeCandidateMaterial {
  const raw = object(value, context);
  const optionalKeys = v2OptionalCandidateKeys(raw, schemaVersion);
  exactKeys(raw, [
    "stableOutcomeId", "outcome", "evidence", "provenance", "readiness",
    "relationshipCandidates", "suggestions", ...optionalKeys,
  ], context);
  const acceptanceCriteria = optionalKeys.includes("acceptanceCriteria")
    ? parseAcceptanceCriteria(raw.acceptanceCriteria, `${context}.acceptanceCriteria`)
    : [];
  const startCommand = optionalKeys.includes("startCommand") && raw.startCommand !== undefined
    ? enumValue(raw.startCommand, AUTHORED_START_COMMANDS, `${context}.startCommand`)
    : undefined;
  const disposition = optionalKeys.includes("disposition")
    ? parseDisposition(raw.disposition, `${context}.disposition`)
    : undefined;
  const outcome = object(raw.outcome, `${context}.outcome`);
  exactKeys(outcome, ["title", "completionRule", "affectedSystems"], `${context}.outcome`);
  const title = nonEmptyString(outcome.title, `${context}.outcome.title`);
  // GitHub's issue-title limit: https://github.com/dead-claudia/github-limits#issue-title
  // Reject early instead of silently truncating the outcome's meaning at filing time.
  if (title.length > 256) {
    throw new Error(`${context}.outcome.title must be at most 256 characters (GitHub issue title limit).`);
  }
  const evidence = parseEvidence(raw.evidence, `${context}.evidence`);
  const readiness = parseReadiness(raw.readiness, `${context}.readiness`);
  if (readiness.currentMainVerificationEvidenceId !== null) {
    const currentMain = evidence.find((entry) => entry.id === readiness.currentMainVerificationEvidenceId);
    if (currentMain?.kind !== "current_main_verification") {
      throw new Error(`${context}.readiness.currentMainVerificationEvidenceId must cite current_main_verification evidence.`);
    }
  }
  const suggestionsRaw = object(raw.suggestions, `${context}.suggestions`);
  exactKeys(suggestionsRaw, ["type", "priority", "effort"], `${context}.suggestions`);
  const suggestions: OutcomeCandidateMaterial["suggestions"] = {
    type: parseSuggestion(suggestionsRaw.type, ISSUE_TYPE_SUGGESTIONS, `${context}.suggestions.type`),
    priority: parseSuggestion(suggestionsRaw.priority, PRIORITY_SUGGESTIONS, `${context}.suggestions.priority`),
    effort: parseSuggestion(suggestionsRaw.effort, EFFORT_SUGGESTIONS, `${context}.suggestions.effort`),
  };
  if (suggestions.effort.value !== null) {
    if (!readiness.independentlyCloseable || !readiness.completionRuleDefined || !readiness.estimationSubstrate) {
      throw new Error(`${context}.suggestions.effort cannot be set until the Effort readiness gate passes.`);
    }
    if (suggestions.effort.confidence !== "high") {
      throw new Error(`${context}.suggestions.effort requires high confidence when a value is set.`);
    }
  }
  return {
    stableOutcomeId: validateStableIdentifier(raw.stableOutcomeId, `${context}.stableOutcomeId`),
    // Empty criteria must have the same canonical hash and bytes as an absent key.
    ...(acceptanceCriteria.length === 0 ? {} : { acceptanceCriteria }),
    ...(startCommand === undefined ? {} : { startCommand }),
    ...(disposition === undefined ? {} : { disposition }),
    outcome: {
      title,
      completionRule: nonEmptyString(outcome.completionRule, `${context}.outcome.completionRule`),
      affectedSystems: uniqueSortedIdentifiers(outcome.affectedSystems, `${context}.outcome.affectedSystems`),
    },
    evidence,
    provenance: parseProvenance(raw.provenance, `${context}.provenance`),
    readiness,
    relationshipCandidates: parseRelationships(
      raw.relationshipCandidates,
      new Set(evidence.map((entry) => entry.id)),
      `${context}.relationshipCandidates`,
    ),
    suggestions,
  };
}

function assertFutureUserBugPrivacy(
  candidate: OutcomeCandidateMaterial,
  artifactSourceLocator: string,
  context: string,
): void {
  if (candidate.relationshipCandidates.length !== 0) {
    throw new Error(`${context} future user bug candidates cannot carry relationship or lineage data.`);
  }
  const serialized = JSON.stringify(candidate);
  if (/https?:\/\//i.test(serialized) || /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(serialized)) {
    throw new Error(`${context} future user bug candidates cannot carry URLs or user identity.`);
  }
  for (const locator of [
    artifactSourceLocator,
    ...candidate.evidence.map((entry) => entry.sourceLocator),
    ...candidate.provenance.map((entry) => entry.sourceLocator),
  ]) {
    if (/(^|\/)(attachments?|uploads?|replays?|sessions?)(\/|$)/i.test(locator)) {
      throw new Error(`${context} future user bug candidates cannot carry replay or attachment locators.`);
    }
  }
}

export function sourceFingerprintFor(input: {
  readonly repository: OutcomeRepositoryIdentity;
  readonly producerKind: ProducerKind;
  readonly stableArtifactId: string;
  readonly stableOutcomeId: string;
}): string {
  return canonicalJsonSha256({
    repository: {
      databaseId: input.repository.databaseId,
      nodeId: input.repository.nodeId,
    },
    producerKind: input.producerKind,
    stableArtifactId: input.stableArtifactId,
    stableOutcomeId: input.stableOutcomeId,
  });
}

export function emissionContentSha256For(candidate: OutcomeCandidateMaterial): string {
  return canonicalJsonSha256(candidate);
}

function envelopeBase(rawValue: unknown): {
  readonly raw: JsonObject;
  readonly schemaVersion: OutcomeEnvelope["schemaVersion"];
  readonly repository: OutcomeRepositoryIdentity;
  readonly producer: OutcomeEnvelope["producer"];
  readonly artifact: OutcomeEnvelope["artifact"];
} {
  const raw = object(rawValue, "outcome envelope");
  exactKeys(raw, ["schemaVersion", "repository", "producer", "artifact", "candidates"], "outcome envelope");
  const schemaVersion = enumValue(raw.schemaVersion, OUTCOME_ENVELOPE_SCHEMA_VERSIONS, "outcome envelope.schemaVersion");
  const producerRaw = object(raw.producer, "outcome envelope.producer");
  exactKeys(producerRaw, ["kind", "version"], "outcome envelope.producer");
  const artifactRaw = object(raw.artifact, "outcome envelope.artifact");
  exactKeys(artifactRaw, ["stableId", "revisionSha256", "sourceLocator"], "outcome envelope.artifact");
  return {
    raw,
    schemaVersion,
    repository: repository(raw.repository),
    producer: {
      kind: enumValue(producerRaw.kind, PRODUCER_KINDS, "outcome envelope.producer.kind"),
      version: validateStableIdentifier(producerRaw.version, "outcome envelope.producer.version"),
    },
    artifact: {
      stableId: validateStableIdentifier(artifactRaw.stableId, "outcome envelope.artifact.stableId"),
      revisionSha256: validateSha256(artifactRaw.revisionSha256, "outcome envelope.artifact.revisionSha256"),
      sourceLocator: validateSafeSourceLocator(artifactRaw.sourceLocator, "outcome envelope.artifact.sourceLocator"),
    },
  };
}

function finishEnvelope(
  base: ReturnType<typeof envelopeBase>,
  candidates: OutcomeCandidate[],
): OutcomeEnvelope {
  const stableIds = candidates.map((candidate) => candidate.stableOutcomeId);
  const fingerprints = candidates.map((candidate) => candidate.sourceFingerprint);
  if (new Set(stableIds).size !== stableIds.length) {
    throw new Error("outcome envelope.candidates contains duplicate stableOutcomeId values.");
  }
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new Error("outcome envelope.candidates contains duplicate source fingerprints.");
  }
  candidates.sort((left, right) => compareCanonicalStrings(left.sourceFingerprint, right.sourceFingerprint));
  return {
    schemaVersion: base.schemaVersion,
    repository: base.repository,
    producer: base.producer,
    artifact: base.artifact,
    candidates,
  };
}

export function createOutcomeEnvelope(rawValue: unknown): OutcomeEnvelope {
  const base = envelopeBase(rawValue);
  if (!Array.isArray(base.raw.candidates)) throw new Error("outcome envelope.candidates must be an array.");
  const candidates = base.raw.candidates.map((entry, index) => {
    const material = parseMaterial(entry, `outcome envelope.candidates[${index}]`, base.schemaVersion);
    if (base.producer.kind === "future_user_bug") {
      assertFutureUserBugPrivacy(
        material,
        base.artifact.sourceLocator,
        `outcome envelope.candidates[${index}]`,
      );
    }
    return {
      ...material,
      sourceFingerprint: sourceFingerprintFor({
        repository: base.repository,
        producerKind: base.producer.kind,
        stableArtifactId: base.artifact.stableId,
        stableOutcomeId: material.stableOutcomeId,
      }),
      emissionContentSha256: emissionContentSha256For(material),
    };
  });
  return finishEnvelope(base, candidates);
}

export function parseOutcomeEnvelope(rawValue: unknown): OutcomeEnvelope {
  const base = envelopeBase(rawValue);
  if (!Array.isArray(base.raw.candidates)) throw new Error("outcome envelope.candidates must be an array.");
  const candidates = base.raw.candidates.map((entry, index) => {
    const context = `outcome envelope.candidates[${index}]`;
    const raw = object(entry, context);
    exactKeys(raw, [
      "stableOutcomeId", "sourceFingerprint", "emissionContentSha256", "outcome", "evidence",
      "provenance", "readiness", "relationshipCandidates", "suggestions",
      ...v2OptionalCandidateKeys(raw, base.schemaVersion),
    ], context);
    const material = parseMaterial(
      Object.fromEntries(Object.entries(raw).filter(([key]) =>
        key !== "sourceFingerprint" && key !== "emissionContentSha256")),
      context,
      base.schemaVersion,
    );
    if (base.producer.kind === "future_user_bug") {
      assertFutureUserBugPrivacy(material, base.artifact.sourceLocator, context);
    }
    const expectedFingerprint = sourceFingerprintFor({
      repository: base.repository,
      producerKind: base.producer.kind,
      stableArtifactId: base.artifact.stableId,
      stableOutcomeId: material.stableOutcomeId,
    });
    const sourceFingerprint = validateSha256(raw.sourceFingerprint, `${context}.sourceFingerprint`);
    if (sourceFingerprint !== expectedFingerprint) {
      throw new Error(`${context}.sourceFingerprint disagrees with its stable identity.`);
    }
    const expectedEmissionHash = emissionContentSha256For(material);
    const emissionContentSha256 = validateSha256(
      raw.emissionContentSha256,
      `${context}.emissionContentSha256`,
    );
    if (emissionContentSha256 !== expectedEmissionHash) {
      throw new Error(`${context}.emissionContentSha256 disagrees with canonical candidate content.`);
    }
    return { ...material, sourceFingerprint, emissionContentSha256 };
  });
  return finishEnvelope(base, candidates);
}

export function outcomeEnvelopeJson(envelope: OutcomeEnvelope): string {
  return prettyCanonicalJson(envelope);
}
