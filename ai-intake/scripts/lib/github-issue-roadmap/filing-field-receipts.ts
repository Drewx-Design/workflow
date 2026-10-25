import { canonicalJson } from "./canonical-json";

export const FILING_FIELD_RECEIPTS_SCHEMA = "github-issue-roadmap-filing-field-receipts/v1";

interface FilingFieldReceipt {
  readonly issueNumber: number;
  readonly field: "Priority" | "Effort";
  readonly value: string;
  readonly eventId: string;
  readonly eventCreatedAt: string;
  readonly writeStartedAt: string;
  readonly readBackAt: string;
  readonly sourceFingerprint: string;
}

interface FilingFieldReceipts {
  readonly schemaVersion: typeof FILING_FIELD_RECEIPTS_SCHEMA;
  readonly repository: string;
  readonly generatedAt: string;
  readonly records: readonly FilingFieldReceipt[];
}

const RECEIPT_KEYS = ["field", "value", "eventId", "eventCreatedAt", "writeStartedAt", "readBackAt"];
const RECORD_KEYS = ["issueNumber", ...RECEIPT_KEYS, "sourceFingerprint"];
const DOCUMENT_KEYS = ["schemaVersion", "repository", "generatedAt", "records"];

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function isRepository(value: unknown): value is string {
  return typeof value === "string" && /^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(value);
}

function isIssueNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function hasValidReceiptValues(value: Record<string, unknown>): boolean {
  return (value.field === "Priority" || value.field === "Effort") &&
    isNonEmptyString(value.value) && isNonEmptyString(value.eventId) &&
    isIsoTimestamp(value.eventCreatedAt) && isIsoTimestamp(value.writeStartedAt) && isIsoTimestamp(value.readBackAt);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildFilingFieldReceipts(
  records: readonly unknown[],
  input: { repository: string; generatedAt: string },
): { document: FilingFieldReceipts; skippedMalformed: number; droppedConflicts: number } {
  const byEventId = new Map<string, FilingFieldReceipt>();
  const conflicts = new Set<string>();
  let skippedMalformed = 0;

  for (const record of records) {
    if (!isObject(record) || record.event !== "complete" || typeof record.repository !== "string" ||
      record.repository.toLowerCase() !== input.repository.toLowerCase() || record.fieldReceipts === undefined) continue;
    if (!Array.isArray(record.fieldReceipts)) {
      skippedMalformed++;
      continue;
    }
    for (const receipt of record.fieldReceipts) {
      if (!isIssueNumber(record.issueNumber) || !isNonEmptyString(record.sourceFingerprint) ||
        !isObject(receipt) || !hasExactKeys(receipt, RECEIPT_KEYS) || !hasValidReceiptValues(receipt)) {
        skippedMalformed++;
        continue;
      }
      const candidate: FilingFieldReceipt = {
        issueNumber: record.issueNumber,
        field: receipt.field as FilingFieldReceipt["field"],
        value: receipt.value as string,
        eventId: receipt.eventId as string,
        eventCreatedAt: receipt.eventCreatedAt as string,
        writeStartedAt: receipt.writeStartedAt as string,
        readBackAt: receipt.readBackAt as string,
        sourceFingerprint: record.sourceFingerprint,
      };
      if (conflicts.has(candidate.eventId)) continue;
      const prior = byEventId.get(candidate.eventId);
      if (prior !== undefined && (prior.issueNumber !== candidate.issueNumber ||
        prior.field !== candidate.field || prior.value !== candidate.value)) {
        byEventId.delete(candidate.eventId);
        conflicts.add(candidate.eventId);
      } else if (prior === undefined || compareText(canonicalJson(candidate), canonicalJson(prior)) < 0) {
        // The same write can be journaled again with different read-back metadata. Choose stably.
        byEventId.set(candidate.eventId, candidate);
      }
    }
  }

  return {
    document: {
      schemaVersion: FILING_FIELD_RECEIPTS_SCHEMA,
      repository: input.repository,
      generatedAt: input.generatedAt,
      records: [...byEventId.values()].sort((left, right) => left.issueNumber - right.issueNumber ||
        compareText(left.field, right.field) || compareText(left.eventId, right.eventId)),
    },
    skippedMalformed,
    // Count conflicting event IDs, regardless of how many copies were dropped.
    droppedConflicts: conflicts.size,
  };
}

export function parseFilingFieldReceipts(raw: unknown): FilingFieldReceipts {
  if (!isObject(raw) || !hasExactKeys(raw, DOCUMENT_KEYS) ||
    raw.schemaVersion !== FILING_FIELD_RECEIPTS_SCHEMA || !isRepository(raw.repository) ||
    !isIsoTimestamp(raw.generatedAt) || !Array.isArray(raw.records)) {
    throw new Error("Invalid filing field receipts document.");
  }
  for (const [index, record] of raw.records.entries()) {
    if (!isObject(record) || !hasExactKeys(record, RECORD_KEYS) || !isIssueNumber(record.issueNumber) ||
      !isNonEmptyString(record.sourceFingerprint) || !hasValidReceiptValues(record)) {
      throw new Error(`Invalid filing field receipts record at index ${index}.`);
    }
  }
  return raw as unknown as FilingFieldReceipts;
}
