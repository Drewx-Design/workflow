import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeSync } from "node:fs";
import { homedir, hostname, uptime } from "node:os";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";

import { canonicalJsonSha256 } from "./canonical-json";

export interface JournalTail {
  readonly bytes: Buffer;
  readonly malformed: true;
}

export interface JournalRead {
  readonly records: unknown[];
  readonly tail: JournalTail | null;
  readonly provisioned: boolean;
}

export class JournalWriteError extends Error {
  constructor(path: string, cause: unknown) {
    super(`Execution journal write failed: ${path}`, { cause });
    this.name = "JournalWriteError";
  }
}

interface ExecutionOwner {
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly bootEpochMs: number;
  // Claims written before uptime was recorded fall back to the PID check.
  readonly holderUptimeS?: number;
  readonly acquiredAt: string;
  readonly mode: "execute" | "import" | "resolve" | "preflight" | "decision-post";
  readonly planPath?: string;
}

export class ExecutionClaimRefusedError extends Error {
  /** Only `live_holder` means another run is working; the other two need an operator. */
  readonly reason: "live_holder" | "unverifiable_holder" | "undiagnosable";

  constructor(readonly lockPath: string, owner: ExecutionOwner | null, live = executionOwnerState(owner) === "live") {
    super(owner === null
      ? `Execution journal claim refused: ${lockPath} is occupied and undiagnosable (owner.json is missing, unreadable, or invalid). Remove this directory by hand only after confirming no intake run is live.`
      : `Execution journal claim refused: ${lockPath} is held by pid ${owner.pid} on ${owner.hostname}, acquiredAt ${owner.acquiredAt}, mode ${owner.mode}. The run must be stopped (or the host restarted) before the claim can be cleared; if pid ${owner.pid} is not an intake run, stop it or reboot.`);
    this.name = "ExecutionClaimRefusedError";
    this.reason = owner === null ? "undiagnosable" : live ? "live_holder" : "unverifiable_holder";
  }
}

function executionOwnerState(owner: ExecutionOwner | null): "live" | "dead" | "unknown" {
  if (owner === null || owner.hostname !== hostname()) return "unknown";
  // Time held never grants ownership. Only a reboot or a dead PID can do so.
  if (owner.holderUptimeS !== undefined && uptime() < owner.holderUptimeS) return "dead";
  // A reused PID looks alive and deliberately over-refuses.
  try { process.kill(owner.pid, 0); return "live"; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"; }
}

export class ExecutionOwnershipError extends Error {
  constructor(lockPath: string) {
    super(`Execution journal ownership lost: ${lockPath}; owner metadata is missing, unreadable, or belongs to someone else. No write or release is permitted.`);
    this.name = "ExecutionOwnershipError";
  }
}

function readExecutionOwner(lockPath: string, filename = "owner.json"): ExecutionOwner | null {
  try {
    const owner = JSON.parse(readFileSync(join(lockPath, filename), "utf8")) as ExecutionOwner | null;
    if (owner === null || typeof owner !== "object" || Array.isArray(owner)
      || typeof owner.token !== "string" || !/^[0-9a-f]{32}$/.test(owner.token)
      || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || typeof owner.hostname !== "string" || owner.hostname === ""
      || (owner.holderUptimeS !== undefined && (typeof owner.holderUptimeS !== "number"
        || !Number.isFinite(owner.holderUptimeS) || owner.holderUptimeS < 0))
      || typeof owner.acquiredAt !== "string" || !Number.isFinite(Date.parse(owner.acquiredAt))
      || (owner.mode !== "execute" && owner.mode !== "import" && owner.mode !== "resolve"
        && owner.mode !== "preflight" && owner.mode !== "decision-post")
      || (owner.planPath !== undefined && typeof owner.planPath !== "string")) return null;
    return owner;
  } catch { return null; }
}

function ownsExecutionClaim(lockPath: string, token: string): boolean {
  const owner = readExecutionOwner(lockPath);
  if (owner !== null) return owner.token === token;
  try {
    const files = readdirSync(lockPath);
    // A present owner.json is authoritative, including unreadable/invalid metadata.
    if (files.includes("owner.json")) return false;
    const parked = files.filter((file) => file.startsWith("owner.stale."));
    // A reclaimer must restore a parked file on token mismatch and can only
    // unlink the stale token it diagnosed, never our live token. Exactly one
    // parked file bearing our token therefore proves we still own the claim.
    // owner.released.* is not evidence: release is ours and we never fence after it.
    return parked.length === 1 && readExecutionOwner(lockPath, parked[0])?.token === token;
  } catch { return false; }
}

function writeDurableJsonLine(path: string, record: unknown, flag: "a" | "wx"): void {
  const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  const file = openSync(path, flag);
  try {
    let offset = 0;
    while (offset < line.length) {
      const written = writeSync(file, line, offset, line.length - offset);
      if (written <= 0) throw new Error("Journal write made no progress.");
      offset += written;
    }
    // File fsync is required. Directory fsync is not portable on Windows.
    fsyncSync(file);
  } finally { closeSync(file); }
}

export function acquireExecutionClaim(journalPath: string, input: {
  readonly mode: "execute" | "import" | "resolve" | "preflight" | "decision-post";
  readonly planPath?: string;
}) {
  const lockPath = join(dirname(journalPath), "execution.lock");
  const holderUptimeS = uptime();
  const owner: ExecutionOwner = {
    token: randomBytes(16).toString("hex"), pid: process.pid, hostname: hostname(),
    bootEpochMs: Math.round((Date.now() - holderUptimeS * 1000) / 1000) * 1000,
    holderUptimeS,
    acquiredAt: new Date().toISOString(), mode: input.mode,
    ...(input.planPath === undefined ? {} : { planPath: input.planPath }),
  };
  mkdirSync(dirname(journalPath), { recursive: true });
  try { mkdirSync(lockPath); }
  catch {
    const holder = readExecutionOwner(lockPath);
    const holderState = executionOwnerState(holder);
    if (holderState !== "dead") throw new ExecutionClaimRefusedError(lockPath, holder, holderState === "live");
    try {
      // Atomically take the file we will inspect and remove. Never unlink a path
      // whose owner could have changed since diagnosis.
      const staleName = `owner.stale.${owner.token}`;
      const stalePath = join(lockPath, staleName);
      renameSync(join(lockPath, "owner.json"), stalePath);
      if (readExecutionOwner(lockPath, staleName)?.token !== holder!.token) {
        renameSync(stalePath, join(lockPath, "owner.json"));
        throw new ExecutionClaimRefusedError(lockPath, readExecutionOwner(lockPath));
      }
      unlinkSync(stalePath);
      rmdirSync(lockPath);
      // Exactly one retry. Another contender may have acquired the directory.
      mkdirSync(lockPath);
    } catch { throw new ExecutionClaimRefusedError(lockPath, readExecutionOwner(lockPath)); }
  }
  const withOwnership = <T>(action: () => T): T => {
    if (!ownsExecutionClaim(lockPath, owner.token)) throw new ExecutionOwnershipError(lockPath);
    // No await between validation and the local write / remote dispatch. This does
    // not fence GitHub acceptance of a request that was already issued.
    return action();
  };
  const release = () => {
    try {
      const releasedName = `owner.released.${owner.token}`;
      const releasedPath = join(lockPath, releasedName);
      try { renameSync(join(lockPath, "owner.json"), releasedPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ExecutionOwnershipError(lockPath);
        throw error;
      }
      if (readExecutionOwner(lockPath, releasedName)?.token !== owner.token) {
        renameSync(releasedPath, join(lockPath, "owner.json"));
        throw new ExecutionOwnershipError(lockPath);
      }
      unlinkSync(releasedPath);
      rmdirSync(lockPath);
    } catch (error) {
      // Filesystem errors can include the private token in their source/dest
      // paths. Cleanup diagnostics are public in both results and error causes.
      if (error instanceof Error && error.message.includes(owner.token)) {
        throw new Error(error.message.replaceAll(owner.token, "[redacted]"));
      }
      throw error;
    }
  };
  try { writeDurableJsonLine(join(lockPath, "owner.json"), owner, "wx"); }
  catch (error) {
    // A partial/unreadable owner remains occupied; cleanup also requires our token.
    let cleanup = "Claim directory removed.";
    try { release(); }
    catch { cleanup = "Claim directory retained; remove it by hand only after confirming no intake run is live."; }
    throw new Error(`Execution claim owner write failed: ${lockPath} (${error instanceof Error ? error.message : String(error)}). ${cleanup}`, { cause: error });
  }
  return {
    ownership: { acquired: true as const, pid: owner.pid, acquiredAt: owner.acquiredAt },
    withOwnership,
    release,
  };
}

/** A runner may borrow ownership, but only its acquiring caller may release it. */
export type ExecutionClaim = ReturnType<typeof acquireExecutionClaim>;

class JournalDirectoryCaseConflictError extends Error {
  constructor(expectedDirectory: string, existingDirectory: string) {
    super(`Execution journal directory casing conflict: expected "${expectedDirectory}", but differently-cased directory "${existingDirectory}" exists.`);
    this.name = "JournalDirectoryCaseConflictError";
  }
}

export function foldRepository(repository: string): string {
  return repository.toLowerCase();
}

export function resolveJournalPath(repository: string): string {
  if (!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(repository)) {
    throw new Error("Journal repository must be canonical OWNER/REPO text.");
  }
  const root = process.env.ROADMAP_INTAKE_JOURNAL_ROOT ?? join(homedir(), ".example-repo", "roadmap-intake");
  // A relative override would silently restore checkout-dependent ownership.
  if (!(process.platform === "win32" ? win32.isAbsolute(root) : isAbsolute(root))) {
    throw new Error("ROADMAP_INTAKE_JOURNAL_ROOT must be an absolute path.");
  }
  if (process.platform === "win32" && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/.test(root)) {
    throw new Error("ROADMAP_INTAKE_JOURNAL_ROOT must be a drive-qualified absolute path or UNC path on Windows.");
  }
  const segment = foldRepository(repository).replace("/", "--");
  try {
    const sibling = readdirSync(root, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name !== segment && entry.name.toLowerCase() === segment);
    if (sibling !== undefined) throw new JournalDirectoryCaseConflictError(join(root, segment), join(root, sibling.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return join(root, segment, "execution.journal.jsonl");
}

function parseLine(line: string): unknown {
  try { return JSON.parse(line) as unknown; }
  catch { return { malformedJson: line }; }
}

export function readJournal(path: string): JournalRead {
  let bytes: Buffer;
  try { bytes = readFileSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], tail: null, provisioned: false };
    throw error;
  }
  const end = bytes.lastIndexOf(0x0a) + 1;
  const records = bytes.subarray(0, end).toString("utf8").split(/\r?\n/)
    .filter((line) => line.trim() !== "").map(parseLine);
  return { records, tail: end === bytes.length ? null : { bytes: bytes.subarray(end), malformed: true }, provisioned: true };
}

export function appendJournal(path: string, record: unknown): void {
  try {
    // Never concatenate a new event onto a torn line or repair persisted bytes.
    if (readJournal(path).tail !== null) throw new Error("Journal has an unterminated tail; append refused.");
    mkdirSync(dirname(path), { recursive: true });
    writeDurableJsonLine(path, record, "a");
  } catch (error) {
    throw new JournalWriteError(path, error);
  }
}

export interface LegacyImportProblem {
  readonly path: string;
  readonly lineNumber: number;
  readonly reason: string;
}

export interface LegacyImportCounts {
  readonly imported: number;
  readonly skipped: number;
  readonly rejected: number;
  readonly malformed: number;
  readonly rejectedLines: readonly LegacyImportProblem[];
  readonly malformedLines: readonly LegacyImportProblem[];
}

class ImportRefusedError extends Error {
  constructor(readonly counts: LegacyImportCounts) {
    const problems = [
      ...counts.rejectedLines.map((line) => `${line.path}:${line.lineNumber}: rejected: ${line.reason}`),
      ...counts.malformedLines.map((line) => `${line.path}:${line.lineNumber}: malformed: ${line.reason}`),
    ];
    super(`Legacy ledger import refused; nothing appended (rejected=${counts.rejected}, malformed=${counts.malformed}, skipped=${counts.skipped}).\n${problems.join("\n")}`);
    this.name = "ImportRefusedError";
  }
}

function isLegacyLedgerRow(row: Record<string, unknown>): boolean {
  if (![row.sourceFingerprint, row.candidateFingerprint].some((value) => typeof value === "string" && value !== "")) return false;
  if (row.schemaVersion !== undefined && row.schemaVersion !== "github-issue-roadmap-intake-approval-ledger/v1") return false;
  if (row.repository != null && (typeof row.repository !== "string" || !/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(row.repository))) return false;
  if (row.mode === "dry-run" || (row.mode === "execute" && row.executed === false)) return true;
  if (row.executed !== true || row.result === null || typeof row.result !== "object" || Array.isArray(row.result)) return false;
  const result = row.result as Record<string, unknown>;
  if (result.issueNumber != null && (typeof result.issueNumber !== "number" || !Number.isSafeInteger(result.issueNumber) || result.issueNumber <= 0)) return false;
  return [result.issueId, result.commentId].every((value) => value == null
    || (typeof value === "string" && value.length > 0) || (typeof value === "number" && Number.isSafeInteger(value)));
}

export function importLegacyLedgers(
  journalPath: string,
  ledgerPaths: readonly string[],
  appendRecord: (record: unknown) => void = (record) => appendJournal(journalPath, record),
): LegacyImportCounts {
  const journal = readJournal(journalPath);
  const seen = new Set<string>();
  const key = (path: string, row: unknown) => `${path}\0${canonicalJsonSha256(row)}`;
  for (const raw of journal.records) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const event = raw as Record<string, unknown>;
    if (event.kind === "legacy_import" && typeof event.importedFrom === "string" && "row" in event) {
      seen.add(key(event.importedFrom, event.row));
    }
  }
  let skipped = 0;
  const rejectedLines: LegacyImportProblem[] = [];
  const malformedLines: LegacyImportProblem[] = [];
  const pending: { importedFrom: string; row: unknown }[] = [];
  for (const ledgerPath of ledgerPaths) {
    const importedFrom = resolve(ledgerPath);
    if (importedFrom === resolve(journalPath)) throw new Error("Cannot import the execution journal into itself.");
    for (const [index, line] of readFileSync(importedFrom, "utf8").split(/\r?\n/).entries()) {
      if (line.trim() === "") continue;
      const location = { path: importedFrom, lineNumber: index + 1 };
      let row: unknown;
      try { row = JSON.parse(line) as unknown; }
      catch { malformedLines.push({ ...location, reason: "Invalid JSON." }); continue; }
      if (row === null || typeof row !== "object" || Array.isArray(row)) {
        malformedLines.push({ ...location, reason: "Legacy ledger row must be a JSON object." }); continue;
      }
      const record = row as Record<string, unknown>;
      if (record.kind === "legacy_import" || ("importedFrom" in record && "row" in record)
        || "event" in record || (typeof record.kind === "string"
          && ["intent", "created", "complete", "classification_failed", "create_unresolved"].includes(record.kind))) {
        rejectedLines.push({ ...location, reason: "Journal envelopes and staged events cannot be imported as legacy ledger rows." }); continue;
      }
      if (!isLegacyLedgerRow(record)) { malformedLines.push({ ...location, reason: "Invalid legacy ledger row shape." }); continue; }
      const identity = key(importedFrom, row);
      if (seen.has(identity)) { skipped += 1; continue; }
      pending.push({ importedFrom, row });
      seen.add(identity);
    }
  }
  const counts = { imported: 0, skipped, rejected: rejectedLines.length, malformed: malformedLines.length, rejectedLines, malformedLines };
  if (counts.rejected > 0 || counts.malformed > 0) throw new ImportRefusedError(counts);
  // Validate the entire input set before allowing any ownership evidence to be appended.
  for (const { importedFrom, row } of pending) {
    appendRecord({ kind: "legacy_import", importedFrom, importedAt: new Date().toISOString(), row });
  }
  return { ...counts, imported: pending.length };
}
