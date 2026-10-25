import { canonicalJsonSha256, prettyCanonicalJson } from "./canonical-json";
import {
  outcomeSourceContentMatchesSha256,
  outcomeSourceContentSha256,
  validateSafeSourceLocator,
  validateStableIdentifier,
} from "./outcome-candidate";

export const EXISTENCE_RECORD_SCHEMA = "github-issue-roadmap-existence-record/v1";

export const EXISTENCE_STATES = [
  "demonstrated",
  "partially_demonstrated",
  "not_demonstrated",
] as const;

export const EXISTENCE_RUN_OUTCOME_KINDS = ["read_failure", "budget_exhausted"] as const;

export type ExistenceState = typeof EXISTENCE_STATES[number];
export type ExistenceRunOutcomeKind = typeof EXISTENCE_RUN_OUTCOME_KINDS[number];

export interface ExistenceRepositoryIdentity {
  readonly organization: string;
  readonly name: string;
  readonly databaseId: number;
  readonly nodeId: string;
}

export interface ExistenceCodeCitation {
  readonly sourceLocator: string;
  readonly contentSha256: string;
  readonly startLine: number;
  readonly endLine: number;
}

export interface SatisfiedExistenceClause {
  readonly clause: string;
  readonly satisfied: true;
  readonly citation: ExistenceCodeCitation;
}

export interface UnsatisfiedExistenceClause {
  readonly clause: string;
  readonly satisfied: false;
}

export type ExistenceClause = SatisfiedExistenceClause | UnsatisfiedExistenceClause;

export interface ExistenceMergedCommitReceipt {
  readonly mergeCommitSha: string;
  readonly url: string;
}

export interface ExistenceSearchAttestation {
  readonly scope: readonly string[];
  readonly budgetConsumed: number;
  readonly clausesEvaluated: number;
  readonly clausesTotal: number;
}

export interface DemonstratedExistenceEvidence {
  readonly mergedCommitReceipt: ExistenceMergedCommitReceipt;
  readonly satisfiedClauses: readonly SatisfiedExistenceClause[];
}

export interface PartiallyDemonstratedExistenceEvidence {
  readonly clauses: readonly ExistenceClause[];
}

export interface NotDemonstratedExistenceEvidence {
  readonly clauses: readonly UnsatisfiedExistenceClause[];
  readonly searchAttestation: ExistenceSearchAttestation;
}

interface ExistenceEntryIdentity {
  readonly sourceFingerprint: string;
  readonly emissionContentSha256: string;
}

export interface DemonstratedExistenceEntry extends ExistenceEntryIdentity {
  readonly state: "demonstrated";
  readonly evidence: DemonstratedExistenceEvidence;
}

export interface PartiallyDemonstratedExistenceEntry extends ExistenceEntryIdentity {
  readonly state: "partially_demonstrated";
  readonly evidence: PartiallyDemonstratedExistenceEvidence;
}

export interface NotDemonstratedExistenceEntry extends ExistenceEntryIdentity {
  readonly state: "not_demonstrated";
  readonly evidence: NotDemonstratedExistenceEvidence;
}

export interface ExistenceReadFailureOutcome {
  readonly kind: "read_failure";
}

export interface ExistenceBudgetExhaustedOutcome {
  readonly kind: "budget_exhausted";
  readonly clausesEvaluated: number;
  readonly clausesTotal: number;
}

export type ExistenceRunOutcome =
  | ExistenceReadFailureOutcome
  | ExistenceBudgetExhaustedOutcome;

export interface ExistenceRunOutcomeEntry extends ExistenceEntryIdentity {
  readonly runOutcome: ExistenceRunOutcome;
}

export type ExistenceStateEntry =
  | DemonstratedExistenceEntry
  | PartiallyDemonstratedExistenceEntry
  | NotDemonstratedExistenceEntry;

export type ExistenceEntry = ExistenceStateEntry | ExistenceRunOutcomeEntry;

export interface ExistenceRecordV1 {
  readonly schemaVersion: typeof EXISTENCE_RECORD_SCHEMA;
  readonly repository: ExistenceRepositoryIdentity;
  readonly originMainSha: string;
  readonly generatedAt: string;
  readonly entries: readonly ExistenceEntry[];
  readonly contentSha256: string;
}

/** The part of an existence record a decision actually consumes. */
export function existenceVerdictProjection(record: ExistenceRecordV1): string {
  return JSON.stringify([...record.entries]
    .sort((a, b) => a.sourceFingerprint.localeCompare(b.sourceFingerprint))
    .map((entry) => ({
      sourceFingerprint: entry.sourceFingerprint,
      emissionContentSha256: entry.emissionContentSha256,
      ...("runOutcome" in entry ? { runOutcome: entry.runOutcome.kind } : {
        state: entry.state,
        // Receipt and search-attestation presence are guaranteed by record parsing.
        // Their contents do not select a route. Citation positions and byte hashes
        // likewise do not change which completion clauses have been demonstrated.
        ...(entry.state === "not_demonstrated" ? {} : {
          clauses: (entry.state === "demonstrated"
            ? entry.evidence.satisfiedClauses : entry.evidence.clauses).map((clause) => ({
            clause: clause.clause,
            satisfied: clause.satisfied,
            ...(clause.satisfied ? { sourceLocator: clause.citation.sourceLocator } : {}),
          })),
        }),
      }),
    })));
}

export interface NoExistenceEntry extends ExistenceEntryIdentity {
  readonly kind: "no_entry";
}

export type ExistenceEntryResolution = ExistenceEntry | NoExistenceEntry;

type JsonObject = Record<string, unknown>;

type ParsedStateEvidence =
  | Pick<DemonstratedExistenceEntry, "state" | "evidence">
  | Pick<PartiallyDemonstratedExistenceEntry, "state" | "evidence">
  | Pick<NotDemonstratedExistenceEntry, "state" | "evidence">;

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
  return value;
}

function sha256(value: unknown, context: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${context} must be a lowercase 64-character SHA-256.`);
  }
  return value;
}

function gitSha(value: unknown, context: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${context} must be a lowercase 40-character Git SHA.`);
  }
  return value;
}

function positiveInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${context} must be a positive integer.`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${context} must be a non-negative integer.`);
  }
  return value as number;
}

function timestamp(value: unknown, context: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${context} must be an ISO timestamp.`);
  }
  const normalized = new Date(value).toISOString();
  if (normalized !== value) throw new Error(`${context} must be a canonical ISO timestamp.`);
  return value;
}

function webUrl(value: unknown, context: string): string {
  const text = nonEmptyString(value, context);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${context} must be an absolute HTTP(S) URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${context} must be an absolute HTTP(S) URL.`);
  }
  return text;
}

function repository(value: unknown): ExistenceRepositoryIdentity {
  const context = "existence record.repository";
  const raw = object(value, context);
  exactKeys(raw, ["organization", "name", "databaseId", "nodeId"], context);
  return {
    organization: validateStableIdentifier(raw.organization, `${context}.organization`),
    name: validateStableIdentifier(raw.name, `${context}.name`),
    databaseId: positiveInteger(raw.databaseId, `${context}.databaseId`),
    nodeId: validateStableIdentifier(raw.nodeId, `${context}.nodeId`),
  };
}

function citation(value: unknown, context: string): ExistenceCodeCitation {
  const raw = object(value, context);
  exactKeys(raw, ["sourceLocator", "contentSha256", "startLine", "endLine"], context);
  const startLine = positiveInteger(raw.startLine, `${context}.startLine`);
  const endLine = positiveInteger(raw.endLine, `${context}.endLine`);
  if (endLine < startLine) {
    throw new Error(`${context}.endLine must be greater than or equal to ${context}.startLine.`);
  }
  return {
    sourceLocator: validateSafeSourceLocator(raw.sourceLocator, `${context}.sourceLocator`),
    contentSha256: sha256(raw.contentSha256, `${context}.contentSha256`),
    startLine,
    endLine,
  };
}

function clause(value: unknown, context: string): ExistenceClause {
  const raw = object(value, context);
  if (raw.satisfied === true) {
    exactKeys(raw, ["clause", "satisfied", "citation"], context);
    return {
      clause: nonEmptyString(raw.clause, `${context}.clause`),
      satisfied: true,
      citation: citation(raw.citation, `${context}.citation`),
    };
  }
  if (raw.satisfied === false) {
    exactKeys(raw, ["clause", "satisfied"], context);
    return {
      clause: nonEmptyString(raw.clause, `${context}.clause`),
      satisfied: false,
    };
  }
  throw new Error(`${context}.satisfied must be boolean.`);
}

function clauseVector(value: unknown, context: string): ExistenceClause[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context} must be a non-empty array.`);
  }
  const clauses = value.map((item, index) => clause(item, `${context}[${index}]`));
  if (new Set(clauses.map((item) => item.clause)).size !== clauses.length) {
    throw new Error(`${context} contains duplicate clause text.`);
  }
  return clauses;
}

function stateFromClauses(clauses: readonly ExistenceClause[]): ExistenceState {
  const satisfiedCount = clauses.filter((item) => item.satisfied).length;
  if (satisfiedCount === clauses.length) return "demonstrated";
  if (satisfiedCount === 0) return "not_demonstrated";
  return "partially_demonstrated";
}

function mergedCommitReceipt(
  value: unknown,
  context: string,
): ExistenceMergedCommitReceipt {
  const raw = object(value, context);
  exactKeys(raw, ["mergeCommitSha", "url"], context);
  return {
    mergeCommitSha: gitSha(raw.mergeCommitSha, `${context}.mergeCommitSha`),
    url: webUrl(raw.url, `${context}.url`),
  };
}

function searchAttestation(
  value: unknown,
  context: string,
  clauseCount: number,
): ExistenceSearchAttestation {
  const raw = object(value, context);
  exactKeys(
    raw,
    ["scope", "budgetConsumed", "clausesEvaluated", "clausesTotal"],
    context,
  );
  if (!Array.isArray(raw.scope) || raw.scope.length === 0) {
    throw new Error(`${context}.scope must be a non-empty array.`);
  }
  const scope = raw.scope.map((item, index) => nonEmptyString(item, `${context}.scope[${index}]`));
  const clausesEvaluated = nonNegativeInteger(
    raw.clausesEvaluated,
    `${context}.clausesEvaluated`,
  );
  const clausesTotal = positiveInteger(raw.clausesTotal, `${context}.clausesTotal`);
  if (clausesEvaluated !== clausesTotal || clausesTotal !== clauseCount) {
    throw new Error(`${context} must attest that every recorded clause was evaluated.`);
  }
  return {
    scope,
    budgetConsumed: nonNegativeInteger(raw.budgetConsumed, `${context}.budgetConsumed`),
    clausesEvaluated,
    clausesTotal,
  };
}

function runOutcome(value: unknown, context: string): ExistenceRunOutcome {
  const raw = object(value, context);
  if (!EXISTENCE_RUN_OUTCOME_KINDS.includes(raw.kind as ExistenceRunOutcomeKind)) {
    throw new Error(
      `${context}.kind must be one of [${EXISTENCE_RUN_OUTCOME_KINDS.join(", ")}].`,
    );
  }
  if (raw.kind === "read_failure") {
    exactKeys(raw, ["kind"], context);
    return { kind: "read_failure" };
  }
  exactKeys(raw, ["kind", "clausesEvaluated", "clausesTotal"], context);
  const clausesEvaluated = nonNegativeInteger(
    raw.clausesEvaluated,
    `${context}.clausesEvaluated`,
  );
  const clausesTotal = positiveInteger(raw.clausesTotal, `${context}.clausesTotal`);
  if (clausesEvaluated >= clausesTotal) {
    throw new Error(`${context}.clausesEvaluated must be less than ${context}.clausesTotal.`);
  }
  return { kind: "budget_exhausted", clausesEvaluated, clausesTotal };
}

function entryIdentity(raw: JsonObject, context: string): ExistenceEntryIdentity {
  return {
    sourceFingerprint: sha256(raw.sourceFingerprint, `${context}.sourceFingerprint`),
    emissionContentSha256: sha256(
      raw.emissionContentSha256,
      `${context}.emissionContentSha256`,
    ),
  };
}

function stateEvidence(
  value: unknown,
  context: string,
  suppliedState: unknown,
): ParsedStateEvidence {
  const raw = object(value, context);
  const usesSatisfiedClauses = Object.hasOwn(raw, "satisfiedClauses");
  const usesClauses = Object.hasOwn(raw, "clauses");
  if (usesSatisfiedClauses === usesClauses) {
    throw new Error(`${context} must carry exactly one clause vector.`);
  }
  const clauseKey = usesSatisfiedClauses ? "satisfiedClauses" : "clauses";
  const clauses = clauseVector(raw[clauseKey], `${context}.${clauseKey}`);
  const state = stateFromClauses(clauses);
  const entryContext = context.replace(/\.evidence$/, "");

  if (suppliedState !== undefined) {
    if (!EXISTENCE_STATES.includes(suppliedState as ExistenceState)) {
      throw new Error(`${entryContext}.state must be one of [${EXISTENCE_STATES.join(", ")}].`);
    }
    if (suppliedState !== state) {
      throw new Error(
        `${entryContext} state ${String(suppliedState)} contradicts clause evidence derived as ${state}.`,
      );
    }
  }

  if (state === "demonstrated") {
    exactKeys(raw, ["mergedCommitReceipt", "satisfiedClauses"], context);
    return {
      state,
      evidence: {
        mergedCommitReceipt: mergedCommitReceipt(
          raw.mergedCommitReceipt,
          `${context}.mergedCommitReceipt`,
        ),
        satisfiedClauses: clauses as SatisfiedExistenceClause[],
      },
    };
  }
  if (state === "partially_demonstrated") {
    exactKeys(raw, ["clauses"], context);
    return { state, evidence: { clauses } };
  }
  exactKeys(raw, ["clauses", "searchAttestation"], context);
  return {
    state,
    evidence: {
      clauses: clauses as UnsatisfiedExistenceClause[],
      searchAttestation: searchAttestation(
        raw.searchAttestation,
        `${context}.searchAttestation`,
        clauses.length,
      ),
    },
  };
}

function entry(value: unknown, context: string, requireState: boolean): ExistenceEntry {
  const raw = object(value, context);
  const carriesState = Object.hasOwn(raw, "state");
  const carriesEvidence = Object.hasOwn(raw, "evidence");
  const carriesRunOutcome = Object.hasOwn(raw, "runOutcome");

  if ((carriesState || carriesEvidence) && carriesRunOutcome) {
    throw new Error(`${context} must not carry both state evidence and runOutcome metadata.`);
  }
  if (!carriesEvidence && !carriesRunOutcome) {
    throw new Error(`${context} must carry exactly one of evidence or runOutcome.`);
  }
  if (carriesRunOutcome) {
    exactKeys(raw, ["sourceFingerprint", "emissionContentSha256", "runOutcome"], context);
    return {
      ...entryIdentity(raw, context),
      runOutcome: runOutcome(raw.runOutcome, `${context}.runOutcome`),
    };
  }
  if (requireState && !carriesState) {
    throw new Error(`${context}.state is required in a persisted existence record.`);
  }
  exactKeys(
    raw,
    carriesState
      ? ["sourceFingerprint", "emissionContentSha256", "state", "evidence"]
      : ["sourceFingerprint", "emissionContentSha256", "evidence"],
    context,
  );
  return {
    ...entryIdentity(raw, context),
    ...stateEvidence(raw.evidence, `${context}.evidence`, raw.state),
  } as ExistenceStateEntry;
}

/** Hash source bytes with the same contract used by outcome evidence and provenance. */
export function existenceCitationContentSha256(contents: Uint8Array): string {
  return outcomeSourceContentSha256(contents);
}

/** Compare citation bytes with the existing raw-or-LF-normalized outcome hash contract. */
export function existenceCitationMatchesContent(
  citationValue: Pick<ExistenceCodeCitation, "contentSha256">,
  contents: Uint8Array,
): boolean {
  return outcomeSourceContentMatchesSha256(contents, citationValue.contentSha256);
}

type ExistenceStateEntryInput =
  | (Omit<DemonstratedExistenceEntry, "state"> & { readonly state?: "demonstrated" })
  | (Omit<PartiallyDemonstratedExistenceEntry, "state"> & {
      readonly state?: "partially_demonstrated";
    })
  | (Omit<NotDemonstratedExistenceEntry, "state"> & {
      readonly state?: "not_demonstrated";
    });

export type ExistenceEntryInput = ExistenceStateEntryInput | ExistenceRunOutcomeEntry;

export type ExistenceRecordParts = Omit<
  ExistenceRecordV1,
  "schemaVersion" | "entries" | "contentSha256"
> & { readonly entries: readonly ExistenceEntryInput[] };

/** Construct, derive entry states, and content-address an existence record. */
export function createExistenceRecord(parts: ExistenceRecordParts): ExistenceRecordV1 {
  const context = "existence record parts";
  const raw = object(parts, context);
  exactKeys(raw, ["repository", "originMainSha", "generatedAt", "entries"], context);
  if (!Array.isArray(raw.entries)) throw new Error(`${context}.entries must be an array.`);
  const core = {
    schemaVersion: EXISTENCE_RECORD_SCHEMA,
    repository: repository(raw.repository),
    originMainSha: gitSha(raw.originMainSha, `${context}.originMainSha`),
    generatedAt: timestamp(raw.generatedAt, `${context}.generatedAt`),
    entries: raw.entries.map((item, index) => entry(item, `${context}.entries[${index}]`, false)),
  };
  return parseExistenceRecord({ ...core, contentSha256: canonicalJsonSha256(core) });
}

/** Parse and content-hash-bind a persisted existence verification record. */
export function parseExistenceRecord(value: unknown): ExistenceRecordV1 {
  const context = "existence record";
  const raw = object(value, context);
  exactKeys(raw, [
    "schemaVersion",
    "repository",
    "originMainSha",
    "generatedAt",
    "entries",
    "contentSha256",
  ], context);
  if (raw.schemaVersion !== EXISTENCE_RECORD_SCHEMA) {
    throw new Error(`${context}.schemaVersion must be ${EXISTENCE_RECORD_SCHEMA}.`);
  }
  const originMainSha = gitSha(raw.originMainSha, `${context}.originMainSha`);
  if (!Array.isArray(raw.entries)) throw new Error(`${context}.entries must be an array.`);

  const entries = raw.entries.map((item, index) => entry(item, `${context}.entries[${index}]`, true));
  const fingerprints = entries.map((item) => item.sourceFingerprint);
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new Error(`${context}.entries contains duplicate sourceFingerprint values.`);
  }
  const core = {
    schemaVersion: EXISTENCE_RECORD_SCHEMA as typeof EXISTENCE_RECORD_SCHEMA,
    repository: repository(raw.repository),
    originMainSha,
    generatedAt: timestamp(raw.generatedAt, `${context}.generatedAt`),
    entries,
  };
  const contentSha256 = sha256(raw.contentSha256, `${context}.contentSha256`);
  if (canonicalJsonSha256(core) !== contentSha256) {
    throw new Error(`${context}.contentSha256 mismatch.`);
  }
  return { ...core, contentSha256 };
}

/** Resolve by stable fingerprint, then refuse reuse across changed candidate content. */
export function resolveExistenceEntry(
  record: ExistenceRecordV1,
  candidate: ExistenceEntryIdentity,
): ExistenceEntryResolution {
  const sourceFingerprint = sha256(candidate.sourceFingerprint, "candidate.sourceFingerprint");
  const emissionContentSha256 = sha256(
    candidate.emissionContentSha256,
    "candidate.emissionContentSha256",
  );
  const matched = record.entries.find((item) => item.sourceFingerprint === sourceFingerprint);
  if (!matched) return { kind: "no_entry", sourceFingerprint, emissionContentSha256 };
  if (matched.emissionContentSha256 !== emissionContentSha256) {
    throw new Error(
      "existence record entry.emissionContentSha256 disagrees with the matched candidate.",
    );
  }
  return matched;
}

export function existenceRecordJson(record: ExistenceRecordV1): string {
  return prettyCanonicalJson(record);
}
