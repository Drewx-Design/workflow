import { createHash, randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { defaultHostRoadmapControlRoot } from "./host-lock";
import { parseSourceMarker, type SourceMarkerV1 } from "./source-marker";
import { incidentSourceFingerprint, markerBlocks, sourceMarkersMatchLoosely, sourceMarkersMatchStrictly, type IntakeReadReceipt } from "./intake-snapshot";
import { canonicalJsonSha256 } from "./canonical-json";
import { CANONICAL_REST_API_VERSION } from "./snapshot-v2";

export const CONSUMPTION_LEDGER_SCHEMA = "github-issue-roadmap-consumption-safety-ledger/v2" as const;
const LEGACY_SCHEMA = "github-issue-roadmap-consumption-safety-ledger/v1";
export interface ConsumptionKey { readonly repository: string; readonly capability: string; readonly sourceFingerprint: string; readonly emissionHash: string }
export interface ConsumptionRecord {
  readonly schemaVersion: typeof CONSUMPTION_LEDGER_SCHEMA;
  readonly key: ConsumptionKey;
  readonly attemptId: string;
  readonly proposalSha256: string;
  readonly credentialFingerprints: readonly string[];
  readonly attemptedAt: string;
  readonly status: "attempted" | "ambiguous" | "verified" | "adopted" | "recovered";
  readonly updatedAt: string;
  readonly canonicalBinding: { readonly issueNumber: number; readonly commentId: number | null } | null;
  readonly recoveryApprovalSha256: string | null;
  readonly history?: readonly ConsumptionRecord[];
  readonly recoveryEvidence?: { readonly sha256: string; readonly targetIssueNumber: number | null; readonly conclusion: "no canonical result observed; retry permitted"; readonly markerIncidents?: readonly RecoveryMarkerIncident[] };
}

function sha(value: string, context: string): void { if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${context} must be a lowercase SHA-256.`); }
function normalizedKey(key: ConsumptionKey): ConsumptionKey {
  if (!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(key.repository) || !/^[-a-z0-9_.]+$/.test(key.capability)) throw new Error("Consumption key repository or capability is invalid.");
  sha(key.sourceFingerprint, "sourceFingerprint"); sha(key.emissionHash, "emissionHash");
  return { ...key, repository: key.repository.toLowerCase() };
}
export function consumptionLedgerPath(root: string | undefined, key: ConsumptionKey): string {
  const identity = JSON.stringify(normalizedKey(key));
  return join(resolve(root ?? defaultHostRoadmapControlRoot()), "ledger", `${createHash("sha256").update(identity).digest("hex")}.json`);
}
export class ConsumptionLedgerVersionSkewError extends Error {
  constructor(schemaVersion: string) {
    super(`Consumption ledger version skew: written by a newer version of this tool (${schemaVersion}); upgrade the reader. Interlock remains closed.`);
    this.name = "ConsumptionLedgerVersionSkewError";
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function repositoryOf(value: unknown): string | null {
  if (!object(value) || !object(value.key) || typeof value.key.repository !== "string" || !/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(value.key.repository)) return null;
  return value.key.repository.toLowerCase();
}
function validateRecord(value: unknown, expected?: ConsumptionKey): ConsumptionRecord {
  const corrupt = () => new Error("Consumption safety ledger record is corrupt; interlock remains closed.");
  if (!object(value)) throw corrupt();
  const version = typeof value.schemaVersion === "string" ? /^github-issue-roadmap-consumption-safety-ledger\/v([1-9][0-9]*)$/.exec(value.schemaVersion) : null;
  if (version !== null && Number(version[1]) > 2) throw new ConsumptionLedgerVersionSkewError(value.schemaVersion as string);
  if (value.schemaVersion !== LEGACY_SCHEMA && value.schemaVersion !== CONSUMPTION_LEDGER_SCHEMA) throw corrupt();
  if (!object(value.key) || repositoryOf(value) === null || typeof value.key.capability !== "string" || typeof value.key.sourceFingerprint !== "string" || typeof value.key.emissionHash !== "string") throw corrupt();
  const record = value as unknown as ConsumptionRecord;
  const key = normalizedKey(record.key);
  if (JSON.stringify(record.key) !== JSON.stringify(key) || (expected !== undefined && JSON.stringify(record.key) !== JSON.stringify(normalizedKey(expected))) || !["attempted", "ambiguous", "verified", "adopted", "recovered"].includes(record.status) || typeof record.attemptedAt !== "string" || !Number.isFinite(Date.parse(record.attemptedAt)) || typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt)) || typeof record.attemptId !== "string" || record.attemptId.length === 0 || typeof record.proposalSha256 !== "string" || !Array.isArray(record.credentialFingerprints) || !record.credentialFingerprints.every((value) => typeof value === "string")) throw corrupt();
  if (record.canonicalBinding !== null && (!object(record.canonicalBinding) || !Number.isSafeInteger(record.canonicalBinding.issueNumber) || record.canonicalBinding.issueNumber <= 0 || (record.canonicalBinding.commentId !== null && (!Number.isSafeInteger(record.canonicalBinding.commentId) || record.canonicalBinding.commentId <= 0)))) throw corrupt();
  if (record.recoveryApprovalSha256 !== null) {
    if (typeof record.recoveryApprovalSha256 !== "string") throw corrupt();
    sha(record.recoveryApprovalSha256, "recoveryApprovalSha256");
  }
  sha(record.proposalSha256, "proposalSha256"); record.credentialFingerprints.forEach((value) => sha(value, "credentialFingerprint"));
  if (record.recoveryEvidence !== undefined) {
    const evidence = record.recoveryEvidence;
    if (!object(evidence) || typeof evidence.sha256 !== "string" || evidence.conclusion !== "no canonical result observed; retry permitted" || record.status !== "recovered" || record.canonicalBinding !== null || (evidence.targetIssueNumber !== null && (!Number.isSafeInteger(evidence.targetIssueNumber) || evidence.targetIssueNumber <= 0))) throw corrupt();
    sha(evidence.sha256, "recovery evidence");
  }
  if (record.history !== undefined) {
    if (!Array.isArray(record.history)) throw corrupt();
    const identities = new Set([record.attemptId]);
    for (const entry of record.history) {
      if (!object(entry) || (entry.history !== undefined && (!Array.isArray(entry.history) || entry.history.length !== 0))) throw corrupt();
      const predecessor = validateRecord(entry, key);
      if (predecessor.status !== "recovered" || predecessor.recoveryEvidence === undefined || identities.has(predecessor.attemptId)) throw corrupt();
      identities.add(predecessor.attemptId);
    }
  }
  // Migrate only in memory. Additive fields survive reads and subsequent transitions.
  // Changes to required semantics need a new schema version, not an optional field.
  return { ...record, schemaVersion: CONSUMPTION_LEDGER_SCHEMA };
}
function read(root: string | undefined, key: ConsumptionKey): ConsumptionRecord {
  try { return validateRecord(JSON.parse(readFileSync(consumptionLedgerPath(root, key), "utf8")), key); } catch (error) {
    if (error instanceof ConsumptionLedgerVersionSkewError) throw error;
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Consumption safety ledger is corrupt or unavailable; interlock remains closed. ${error instanceof Error ? error.message : ""}`);
    throw error;
  }
}
function replace(root: string | undefined, key: ConsumptionKey, record: ConsumptionRecord, observed: Buffer | null, preSend = false): ConsumptionRecord {
  const logicalPath = consumptionLedgerPath(root, key);
  const path = join(realpathSync(dirname(logicalPath)), basename(logicalPath));
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let publishing = false;
  try {
    writeFileSync(temp, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (observed === null) {
      // Publish atomically only if absent; never overwrite a competing first write.
      publishing = true;
      linkSync(temp, path);
    } else {
      // Intake holds the host repository lock across the run. This comparison
      // detects a changed predecessor; it does not itself exclude other writers.
      let actual: Buffer | null = null;
      try { actual = readFileSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (actual?.toString("base64") !== observed?.toString("base64")) throw new Error("Observed predecessor changed.");
      renameSync(temp, path);
    }
  } catch (error) {
    if (publishing && (error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new Error(`Consumption publication failed: linkSync to ${path} (${(error as NodeJS.ErrnoException).code ?? "unknown errno"}). This is not a transient condition; repair filesystem support or permissions before retrying. ${preSend ? "No external action was taken by this attempt." : "Reconcile remote outcome before any further send; failure does not establish that nothing happened."}`, { cause: error });
    }
    throw new Error(preSend
      ? "Consumption conditional replace failed before send; no external action was taken by this attempt. A retry is safe."
      : "Consumption conditional replace failed; reconcile remote outcome before any further send. Failure does not establish that nothing happened.", { cause: error });
  } finally { try { unlinkSync(temp); } catch {} }
  return record;
}
export function beginConsumptionAttempt(input: { readonly root?: string; readonly key: ConsumptionKey; readonly credentialFingerprint: string; readonly proposalSha256: string; readonly now?: string }): ConsumptionRecord {
  const key = normalizedKey(input.key); sha(input.credentialFingerprint, "credentialFingerprint"); sha(input.proposalSha256, "proposalSha256");
  const root = input.root ?? defaultHostRoadmapControlRoot();
  const path = consumptionLedgerPath(root, key); mkdirSync(join(resolve(root), "ledger"), { recursive: true });
  let observed: Buffer | null = null;
  let prior: ConsumptionRecord | undefined;
  try { observed = readFileSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (observed !== null) {
    prior = validateRecord(JSON.parse(observed.toString("utf8")), key);
    if (prior.status === "verified" || prior.status === "adopted" || (prior.status === "recovered" && prior.recoveryEvidence === undefined)) throw new Error("Consumption key already completed; no duplicate external action is permitted.");
    if (prior.status !== "recovered" || prior.canonicalBinding !== null) throw new Error("Consumption safety interlock is unresolved; credential rotation, clone changes, and rollback cannot reopen it.");
  }
  const now = input.now ?? new Date().toISOString();
  const record: ConsumptionRecord = { schemaVersion: CONSUMPTION_LEDGER_SCHEMA, key, attemptId: randomUUID(), proposalSha256: input.proposalSha256, credentialFingerprints: [input.credentialFingerprint], attemptedAt: now, status: "attempted", updatedAt: now, canonicalBinding: null, recoveryApprovalSha256: null };
  return replace(root, key, { ...record, ...(prior ? { history: [...(prior.history ?? []), { ...prior, history: [] }] } : {}) }, observed, true);
}
function transition(input: { root?: string; key: ConsumptionKey; attemptId: string; now: string }, status: ConsumptionRecord["status"], binding: ConsumptionRecord["canonicalBinding"], approval: string | null): ConsumptionRecord {
  const observed = readFileSync(consumptionLedgerPath(input.root, input.key));
  const prior = validateRecord(JSON.parse(observed.toString("utf8")), input.key); if (prior.attemptId !== input.attemptId) throw new Error("Consumption attempt identity mismatch.");
  if (prior.status !== "attempted" && !(prior.status === "ambiguous" && (status === "adopted" || status === "recovered"))) throw new Error("Consumption ledger transition is non-monotonic.");
  return replace(input.root, input.key, { ...prior, status, updatedAt: input.now, canonicalBinding: binding, recoveryApprovalSha256: approval }, observed);
}
export function markConsumptionAmbiguous(input: { root?: string; key: ConsumptionKey; attemptId: string; now: string }) { return transition(input, "ambiguous", null, null); }
export function markConsumptionVerified(input: { root?: string; key: ConsumptionKey; attemptId: string; canonicalBinding: NonNullable<ConsumptionRecord["canonicalBinding"]>; now: string }) { return transition(input, "verified", input.canonicalBinding, null); }
export function adoptCanonicalConsumption(input: { root?: string; key: ConsumptionKey; attemptId: string; canonicalBinding: NonNullable<ConsumptionRecord["canonicalBinding"]>; now: string }) { return transition(input, "adopted", input.canonicalBinding, null); }
interface RecoveryMarkerIncident { readonly sourceFingerprint: string | null; readonly raw: string; readonly detail: string }
function censusMarkers(body: string, incidents: RecoveryMarkerIncident[]): SourceMarkerV1[] {
  const markers: SourceMarkerV1[] = [];
  for (const block of markerBlocks(body)) {
    try {
      if (block.modified) throw new Error("The source marker sentinel was modified.");
      markers.push(parseSourceMarker(block.raw));
    } catch (error) {
      incidents.push({ sourceFingerprint: incidentSourceFingerprint(block.raw), raw: block.raw, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return markers;
}

/** Caller-attested raw-page receipts include the caller-reported pagination terminus. */
export interface RecoveryCensusCallerAttestation {
  readonly repository: string;
  readonly coverage: "complete";
  readonly incompleteResults: false;
  readonly expectedCount: number;
  readonly receipts: readonly (IntakeReadReceipt & { readonly nextPage: number | null })[];
}

function recoveryPages(pages: unknown, callerAttestation: RecoveryCensusCallerAttestation | undefined, repository: string, targetIssueNumber: number | null, attemptedAt: string, now: string): Record<string, unknown>[] {
  const invalidAttestation = () => new Error("Recovery census caller attestation is missing or malformed; caller-attested coverage, counts, and page receipts must bind to the supplied pages.");
  if (!Array.isArray(pages) || pages.length === 0 || !pages.every((page) => Array.isArray(page) && page.every(object))) throw invalidAttestation();
  if (!object(callerAttestation) || callerAttestation.repository !== repository || callerAttestation.coverage !== "complete" || callerAttestation.incompleteResults !== false || !Number.isSafeInteger(callerAttestation.expectedCount) || callerAttestation.expectedCount < 0 || !Array.isArray(callerAttestation.receipts) || callerAttestation.receipts.length !== pages.length) throw invalidAttestation();
  const domain = targetIssueNumber === null ? "issues" : "comments";
  const endpoint = `/repos/${repository}/issues${targetIssueNumber === null ? "?state=all&" : `/${targetIssueNumber}/comments?`}per_page=100&page=`;
  for (const [index, page] of pages.entries()) {
    const receipt = callerAttestation.receipts[index];
    if (!object(receipt) || receipt.domain !== domain || receipt.endpoint !== `${endpoint}${index + 1}` || receipt.page !== index + 1 || receipt.nextPage !== (index === pages.length - 1 ? null : index + 2) || receipt.responseSha256 !== canonicalJsonSha256(page) || typeof receipt.requestId !== "string" || !receipt.requestId.trim() || receipt.apiVersion !== CANONICAL_REST_API_VERSION || typeof receipt.fetchedAt !== "string" || !Number.isFinite(Date.parse(receipt.fetchedAt)) || Date.parse(receipt.fetchedAt) > Date.parse(now) || page.length > 100 || (index < pages.length - 1 && page.length !== 100)) throw invalidAttestation();
    if (Date.parse(receipt.fetchedAt) < Date.parse(attemptedAt)) throw invalidAttestation();
  }
  const rows = pages.flat() as Record<string, unknown>[];
  const ids = rows.map((row) => domain === "issues" ? row.number : row.id);
  if (rows.length !== callerAttestation.expectedCount || new Set(ids).size !== rows.length) throw invalidAttestation();
  return rows;
}
// Retain the existing entry-point name for compatibility, but approval digests
// are no longer evidence. U5 may invoke this only after establishing ownership.
export function recoverConsumptionWithApproval(input: { root?: string; key: ConsumptionKey; attemptId: string; expectedMarker: SourceMarkerV1; targetIssueNumber: number | null; issuePages: unknown; issueCallerAttestation?: RecoveryCensusCallerAttestation; commentPages?: unknown; commentCallerAttestation?: RecoveryCensusCallerAttestation; now: string }) {
  if (Object.keys(input).some((name) => !["root", "key", "attemptId", "expectedMarker", "targetIssueNumber", "issuePages", "issueCallerAttestation", "commentPages", "commentCallerAttestation", "now"].includes(name))) throw new Error("Caller-supplied recovery evidence is refused; census evidence must be recomputed.");
  const key = normalizedKey(input.key);
  if (!Number.isFinite(Date.parse(input.now)) || input.expectedMarker.sourceFingerprint !== key.sourceFingerprint || input.expectedMarker.emissionContentSha256 !== key.emissionHash) throw new Error("Recovery marker or time does not bind to the consumption key.");
  if (key.capability !== "create_issue" && key.capability !== "append_evidence") throw new Error("Machine recovery is not defined for this capability.");
  if (key.capability === "create_issue" ? input.targetIssueNumber !== null : !Number.isSafeInteger(input.targetIssueNumber) || input.targetIssueNumber! <= 0) throw new Error("Recovery target does not bind to capability.");
  const observed = readFileSync(consumptionLedgerPath(input.root, key));
  const prior = validateRecord(JSON.parse(observed.toString("utf8")), key);
  if (prior.attemptId !== input.attemptId || !["attempted", "ambiguous"].includes(prior.status)) throw new Error("Recovery requires the examined unresolved attempt.");
  // These fields are supplied by the caller and bound to the caller's own pages.
  // They detect accidental under-collection and provide an audit trail; they do
  // not establish authenticity. A coordinated caller can satisfy every clause
  // with an incomplete census. No GitHub fetch or independent verification occurs here.
  const issues = recoveryPages(input.issuePages, input.issueCallerAttestation, key.repository, null, prior.attemptedAt, input.now).filter((issue) => issue.pull_request === undefined);
  if (key.capability === "create_issue" && (input.commentPages !== undefined || input.commentCallerAttestation !== undefined)) throw new Error("Recovery comments do not bind to capability.");
  const markerIncidents: RecoveryMarkerIncident[] = [];
  const markers = (body: string) => {
    const parsed = censusMarkers(body, markerIncidents);
    if (markerIncidents.some((incident) => incident.sourceFingerprint === key.sourceFingerprint)) throw new Error("Possible canonical claim in malformed marker; reconcile instead of retrying.", { cause: markerIncidents });
    return parsed;
  };
  const claims = issues.filter((issue) => {
    if (!Number.isSafeInteger(issue.number) || (issue.number as number) <= 0 || (issue.body !== null && typeof issue.body !== "string")) throw new Error("Recovery issue census is malformed.");
    // A caller's mismatched descriptive marker fields must never hide a claim
    // for the ledger's own fingerprint. Such a collision requires reconciliation.
    return markers(issue.body ?? "").some((marker) => marker.sourceFingerprint === key.sourceFingerprint || sourceMarkersMatchLoosely(marker, input.expectedMarker));
  });
  if (key.capability === "create_issue" && claims.length !== 0) throw new Error("Canonical result observed or conflicting claims; reconcile instead of retrying.");
  let comments: Record<string, unknown>[] = [];
  if (key.capability === "append_evidence") {
    if (claims.length !== 1 || claims[0].number !== input.targetIssueNumber) throw new Error("Recovery requires one canonical target issue.");
    comments = recoveryPages(input.commentPages, input.commentCallerAttestation, key.repository, input.targetIssueNumber, prior.attemptedAt, input.now);
    for (const comment of comments) {
      if (!Number.isSafeInteger(comment.id) || typeof comment.body !== "string") throw new Error("Recovery comment census is malformed.");
      if (markers(comment.body).some((marker) => (marker.sourceFingerprint === key.sourceFingerprint && marker.emissionContentSha256 === key.emissionHash) || sourceMarkersMatchStrictly(marker, input.expectedMarker))) throw new Error("Canonical result observed; reconcile instead of retrying.");
    }
  }
  const conclusion = "no canonical result observed; retry permitted" as const;
  const digest = createHash("sha256").update(JSON.stringify({ key, attemptId: prior.attemptId, targetIssueNumber: input.targetIssueNumber, expectedMarker: input.expectedMarker, observed: observed.toString("base64"), issues, comments, issueCallerAttestation: input.issueCallerAttestation, commentCallerAttestation: input.commentCallerAttestation, markerIncidents, now: input.now, conclusion })).digest("hex");
  return replace(input.root, key, { ...prior, status: "recovered", updatedAt: input.now, canonicalBinding: null, recoveryApprovalSha256: null, recoveryEvidence: { sha256: digest, targetIssueNumber: input.targetIssueNumber, conclusion, markerIncidents } }, observed);
}
export function inspectConsumptionRecord(root: string | undefined, key: ConsumptionKey): ConsumptionRecord { return read(root, key); }

export interface ConsumptionScanIssue {
  readonly path: string;
  readonly repository: string | null;
  readonly kind: "corrupt" | "unavailable" | "version_skew";
  readonly error?: ConsumptionLedgerVersionSkewError;
  readonly message: string;
}
export interface ConsumptionTotals {
  readonly creates: number;
  readonly comments: number;
  /** Counts are known sends only; admission must refuse when this flag is true. */
  readonly budgetBlocked: boolean;
  readonly issues: readonly ConsumptionScanIssue[];
}
export function recentConsumptionTotals(root: string | undefined, repository: string, now: string): ConsumptionTotals {
  const ledgerDirectory = join(resolve(root ?? defaultHostRoadmapControlRoot()), "ledger");
  let names: string[];
  try { names = readdirSync(ledgerDirectory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { creates: 0, comments: 0, budgetBlocked: false, issues: [] };
    throw new Error("Host-global consumption ledger is unavailable; daily budget fails closed.");
  }
  const threshold = Date.parse(now) - 24 * 60 * 60 * 1000;
  if (!Number.isFinite(threshold)) throw new Error("Invalid budget scan time; daily budget fails closed.");
  const issues: ConsumptionScanIssue[] = [];
  const countedAttempts = new Set<string>();
  let creates = 0; let comments = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let record: ConsumptionRecord;
    const path = join(ledgerDirectory, name);
    let value: unknown;
    try { value = JSON.parse(readFileSync(path, "utf8")); record = validateRecord(value); } catch (error) {
      issues.push({ path, repository: repositoryOf(value), kind: error instanceof ConsumptionLedgerVersionSkewError ? "version_skew" : (error as NodeJS.ErrnoException).code ? "unavailable" : "corrupt", message: error instanceof Error ? error.message : "Unreadable consumption ledger record.", ...(error instanceof ConsumptionLedgerVersionSkewError ? { error } : {}) });
      continue;
    }
    for (const entry of [record, ...(record.history ?? [])]) {
      if (entry.key.repository !== repository.toLowerCase() || Date.parse(entry.attemptedAt) < threshold) continue;
      // Recovery permits a retry but does not prove the predecessor was unsent.
      // Deduplicate across files too: the scan can encounter copied snapshots.
      if (countedAttempts.has(entry.attemptId)) continue;
      countedAttempts.add(entry.attemptId);
      if (entry.key.capability === "create_issue") creates += 1;
      if (entry.key.capability === "append_evidence") comments += 1;
    }
  }
  // Filenames hash the full key and cannot attribute unparseable JSON to a repository.
  // Unknown repository means unknown sends for every repository, regardless of age
  // or capability hints in a record that could not be validated.
  const budgetBlocked = issues.some((issue) => issue.repository === null || issue.repository === repository.toLowerCase());
  return { creates, comments, budgetBlocked, issues };
}
