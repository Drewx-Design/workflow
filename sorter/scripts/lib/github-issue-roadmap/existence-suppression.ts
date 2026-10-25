import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";
import {
  parseExistenceRecord,
  type DemonstratedExistenceEntry,
  type ExistenceMergedCommitReceipt,
  type ExistenceRecordV1,
} from "./existence-record";
import type { ProvisionalSuppressionRoute } from "./existence-routing";

export const EXISTENCE_SUPPRESSION_SCHEMA =
  "github-issue-roadmap-existence-suppression/v1" as const;

type JsonObject = Record<string, unknown>;

export interface ExistenceSuppression {
  readonly schemaVersion: typeof EXISTENCE_SUPPRESSION_SCHEMA;
  readonly sourceFingerprint: string;
  readonly emissionContentSha256: string;
  readonly originMainSha: string;
  readonly mergedCommitReceipt: ExistenceMergedCommitReceipt;
  readonly contentSha256: string;
}

type ExistenceSuppressionCore = Omit<ExistenceSuppression, "contentSha256">;

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

function webUrl(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${context} must be an absolute HTTP(S) URL.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${context} must be an absolute HTTP(S) URL.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${context} must be an absolute HTTP(S) URL.`);
  }
  return value;
}

function mergedCommitReceipt(value: unknown, context: string): ExistenceMergedCommitReceipt {
  const raw = object(value, context);
  exactKeys(raw, ["mergeCommitSha", "url"], context);
  return {
    mergeCommitSha: gitSha(raw.mergeCommitSha, `${context}.mergeCommitSha`),
    url: webUrl(raw.url, `${context}.url`),
  };
}

function suppressionKey(record: Pick<
  ExistenceSuppression,
  "sourceFingerprint" | "emissionContentSha256" | "originMainSha"
>): string {
  return [
    record.sourceFingerprint,
    record.emissionContentSha256,
    record.originMainSha,
  ].join("\0");
}

function suppressionCore(value: unknown, context: string): ExistenceSuppressionCore {
  const raw = object(value, context);
  return {
    schemaVersion: EXISTENCE_SUPPRESSION_SCHEMA,
    sourceFingerprint: sha256(raw.sourceFingerprint, `${context}.sourceFingerprint`),
    emissionContentSha256: sha256(
      raw.emissionContentSha256,
      `${context}.emissionContentSha256`,
    ),
    originMainSha: gitSha(raw.originMainSha, `${context}.originMainSha`),
    mergedCommitReceipt: mergedCommitReceipt(
      raw.mergedCommitReceipt,
      `${context}.mergedCommitReceipt`,
    ),
  };
}

export function parseExistenceSuppression(
  value: unknown,
  context = "existence suppression",
): ExistenceSuppression {
  const raw = object(value, context);
  exactKeys(raw, [
    "schemaVersion",
    "sourceFingerprint",
    "emissionContentSha256",
    "originMainSha",
    "mergedCommitReceipt",
    "contentSha256",
  ], context);
  if (raw.schemaVersion !== EXISTENCE_SUPPRESSION_SCHEMA) {
    throw new Error(`${context}.schemaVersion is unsupported.`);
  }
  const core = suppressionCore(raw, context);
  const contentSha256 = sha256(raw.contentSha256, `${context}.contentSha256`);
  if (canonicalJsonSha256(core) !== contentSha256) {
    throw new Error(`${context}.contentSha256 mismatch.`);
  }
  return { ...core, contentSha256 };
}

function readLedger(ledgerPath: string): ExistenceSuppression[] {
  if (!existsSync(ledgerPath)) return [];
  let contents: string;
  try {
    contents = readFileSync(ledgerPath, "utf8");
  } catch (error) {
    throw new Error(
      `Existence suppression ledger ${ledgerPath} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return contents
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return parseExistenceSuppression(
          JSON.parse(line) as unknown,
          `Existence suppression ledger ${ledgerPath} line ${index + 1}`,
        );
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error(
            `Existence suppression ledger ${ledgerPath} line ${index + 1} is unreadable: ${error.message}`,
          );
        }
        throw error;
      }
    });
}

function reduceLedger(records: readonly ExistenceSuppression[]): ExistenceSuppression[] {
  const byBinding = new Map<string, ExistenceSuppression>();
  for (const record of records) {
    const key = suppressionKey(record);
    const existing = byBinding.get(key);
    if (existing !== undefined && existing.contentSha256 !== record.contentSha256) {
      throw new Error(`Existence suppression ledger contains conflicting records for ${key}.`);
    }
    if (existing === undefined) byBinding.set(key, record);
  }
  return [...byBinding.values()].sort((left, right) =>
    left.sourceFingerprint.localeCompare(right.sourceFingerprint)
      || left.emissionContentSha256.localeCompare(right.emissionContentSha256)
      || left.originMainSha.localeCompare(right.originMainSha)
      || left.contentSha256.localeCompare(right.contentSha256));
}

/** Read the immutable suppression history, reducing exact duplicate events by binding key. */
export function listExistenceSuppressions(ledgerPath: string): ExistenceSuppression[] {
  return reduceLedger(readLedger(ledgerPath));
}

function demonstratedEntry(
  record: ExistenceRecordV1,
  suppression: Pick<ExistenceSuppression, "sourceFingerprint" | "emissionContentSha256">,
): DemonstratedExistenceEntry | undefined {
  const entry = record.entries.find((candidate) =>
    candidate.sourceFingerprint === suppression.sourceFingerprint
      && candidate.emissionContentSha256 === suppression.emissionContentSha256);
  return entry !== undefined && "state" in entry && entry.state === "demonstrated"
    ? entry
    : undefined;
}

function receiptMatches(
  left: ExistenceMergedCommitReceipt,
  right: ExistenceMergedCommitReceipt,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Append an origin/main-bound suppression only when its receipt resolves to the
 * demonstrated entry in the verified, content-bound existence record.
 */
export function appendExistenceSuppression(input: {
  readonly ledgerPath: string;
  readonly route: ProvisionalSuppressionRoute;
  readonly existenceRecord: ExistenceRecordV1;
}): ExistenceSuppression {
  const verified = parseExistenceRecord(input.existenceRecord);
  if (input.route.kind !== "provisional_suppression") {
    throw new Error("Existence suppression requires a provisional_suppression route.");
  }
  const core = suppressionCore({
    schemaVersion: EXISTENCE_SUPPRESSION_SCHEMA,
    sourceFingerprint: input.route.entry.sourceFingerprint,
    emissionContentSha256: input.route.entry.emissionContentSha256,
    originMainSha: input.route.verifiedOriginMainSha,
    mergedCommitReceipt: input.route.mergedCommitReceipt,
  }, "existence suppression input");
  if (core.originMainSha !== verified.originMainSha) {
    throw new Error(
      "Existence suppression originMainSha does not match the verified existence record.",
    );
  }
  const entry = demonstratedEntry(verified, core);
  if (entry === undefined || !receiptMatches(core.mergedCommitReceipt, entry.evidence.mergedCommitReceipt)) {
    throw new Error(
      "Existence suppression mergedCommitReceipt does not resolve to the demonstrated entry in the verified existence record.",
    );
  }

  const suppression = parseExistenceSuppression({
    ...core,
    contentSha256: canonicalJsonSha256(core),
  });
  const existing = listExistenceSuppressions(input.ledgerPath)
    .find((record) => suppressionKey(record) === suppressionKey(suppression));
  if (existing !== undefined) {
    if (existing.contentSha256 !== suppression.contentSha256) {
      throw new Error(
        `Existence suppression ledger already has a conflicting record for ${suppressionKey(suppression)}.`,
      );
    }
    return existing;
  }

  mkdirSync(dirname(input.ledgerPath), { recursive: true });
  appendFileSync(input.ledgerPath, `${canonicalJson(suppression)}\n`, "utf8");
  return suppression;
}

/**
 * Derive active state from the current verified main SHA and its demonstrated
 * verdict. No active or reversal state is persisted.
 */
export function listActiveExistenceSuppressions(input: {
  readonly ledgerPath: string;
  readonly existenceRecord: ExistenceRecordV1;
}): ExistenceSuppression[] {
  const verified = parseExistenceRecord(input.existenceRecord);
  return listExistenceSuppressions(input.ledgerPath).filter((suppression) => {
    if (suppression.originMainSha !== verified.originMainSha) return false;
    const entry = demonstratedEntry(verified, suppression);
    return entry !== undefined
      && receiptMatches(suppression.mergedCommitReceipt, entry.evidence.mergedCommitReceipt);
  });
}
