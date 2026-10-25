import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, win32 } from "node:path";

import { canonicalJsonSha256, sha256Bytes } from "../github-issue-roadmap/canonical-json";
import { acquireExecutionClaim, appendJournal, foldRepository, readJournal, resolveJournalPath } from "../github-issue-roadmap/intake-execution-journal";
import {
  assertArtifactRef, DECISION_SCHEMA, DecisionJournalRefusedError, foldDecisionJournal, parseDecisionEvent, pendingDecisionReversalRecords, rebuildDecisionRecords,
  type ArtifactRef, type DecisionEvent, type DecisionEventInput, type VerifiedDecisionComment,
} from "./state";

function physicalPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(physicalPath(parent), basename(absolute));
  }
}
function comparablePath(path: string): string {
  const physical = physicalPath(path);
  return process.platform === "win32" ? physical.toLowerCase() : physical;
}

// Export the directory for U6's sentinel and U8's artifact storage. Like intake,
// fold OWNER/REPO to owner--repo; the two journals must never share a claim.
export function resolveDecisionDirectory(repository: string): string {
  if (!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(repository)
    || repository.split("/").some((part) => part === "." || part === "..")) {
    throw new DecisionJournalRefusedError("Journal repository must be canonical OWNER/REPO text.");
  }
  const root = process.env.DECISION_SURFACER_JOURNAL_ROOT ?? join(homedir(), ".example-repo", "decision-surfacer");
  if (!(process.platform === "win32" ? win32.isAbsolute(root) : isAbsolute(root))) {
    throw new DecisionJournalRefusedError("DECISION_SURFACER_JOURNAL_ROOT must be an absolute path.");
  }
  if (process.platform === "win32" && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/.test(root)) {
    throw new DecisionJournalRefusedError("DECISION_SURFACER_JOURNAL_ROOT must be a drive-qualified absolute path or UNC path on Windows.");
  }
  const segment = foldRepository(repository).replace("/", "--");
  try {
    const sibling = readdirSync(root, { withFileTypes: true }).find((entry) => entry.isDirectory()
      && entry.name !== segment && entry.name.toLowerCase() === segment);
    if (sibling) throw new DecisionJournalRefusedError(`Journal directory casing conflict: expected ${segment}, found ${sibling.name}.`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const directory = resolve(root, segment);
  const intakeDirectory = dirname(resolveJournalPath(repository));
  if (comparablePath(directory) === comparablePath(intakeDirectory)) {
    throw new DecisionJournalRefusedError(`Decision journal must not share the intake journal directory: ${directory}.`);
  }
  return directory;
}

export function resolveDecisionJournalPath(repository: string): string {
  return join(resolveDecisionDirectory(repository), "decision.journal.jsonl");
}

// Artifacts use the digest of their persisted bytes; structured identities use
// canonicalJsonSha256. Reading here also refuses missing/unreadable artifacts.
export function verifyArtifact(ref: ArtifactRef): void {
  assertArtifactRef(ref);
  let actual: string;
  try { actual = sha256Bytes(readFileSync(ref.path)); }
  catch (error) {
    throw new DecisionJournalRefusedError(`Artifact cannot be read: ${ref.path} (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (actual !== ref.sha256) throw new DecisionJournalRefusedError(`Artifact digest mismatch: ${ref.path}; expected ${ref.sha256}, got ${actual}.`);
}
export function readArtifact(ref: ArtifactRef): string {
  verifyArtifact(ref);
  // Verify returned bytes too, in case the file changed between reads.
  let bytes: Buffer;
  try { bytes = readFileSync(ref.path); }
  catch (error) {
    throw new DecisionJournalRefusedError(`Artifact cannot be read: ${ref.path} (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (sha256Bytes(bytes) !== ref.sha256) throw new DecisionJournalRefusedError(`Artifact digest mismatch: ${ref.path}.`);
  return bytes.toString("utf8");
}

function verifyEventArtifacts(event: DecisionEvent): void {
  event.artifacts?.forEach(verifyArtifact);
  if (event.kind === "criterion_classified") verifyArtifact(event.attempt);
  if (event.kind === "projection_intent") verifyArtifact(event.comment);
}

// Provisioning only: consumers must acquire the claim to validate and recover
// existing history before reading it. A read-only fold still refuses pending batches.
export function isDecisionJournalProvisioned(repository: string): boolean {
  return readJournal(resolveDecisionJournalPath(repository)).provisioned;
}

export function readDecisionJournal(repository: string) {
  const path = resolveDecisionJournalPath(repository);
  const journal = readJournal(path);
  const index = foldDecisionJournal(journal.records, journal.tail);
  index.records.forEach(verifyEventArtifacts);
  return { path, directory: dirname(path), provisioned: journal.provisioned, index };
}

type JournalOptions = { readonly now?: () => Date } & (
  | { readonly mode?: "execute" }
  // U8 must perform its repository-wide marker search before initializing.
  | { readonly mode: "initialize"; readonly existingDecisionMarkers: boolean }
  | { readonly mode: "rebuild" }
);

export function acquireDecisionJournal(repository: string, options: JournalOptions = {}) {
  const path = resolveDecisionJournalPath(repository);
  const mode = options.mode ?? "execute";
  const claim = acquireExecutionClaim(path, { mode: mode === "rebuild" ? "import" : "execute" });
  const now = options.now ?? (() => new Date());
  try {
    const existing = readJournal(path);
    const remaining = pendingDecisionReversalRecords(existing.records, existing.tail);
    foldDecisionJournal([...existing.records, ...remaining], existing.tail).records.forEach(verifyEventArtifacts);
    if (mode === "execute" && !existing.provisioned) {
      throw new DecisionJournalRefusedError("Journal not provisioned; execution refused. Search repository decision markers before initialize, or use rebuild.");
    }
    if (mode !== "execute" && existing.provisioned) {
      throw new DecisionJournalRefusedError("Journal already provisioned; initialize/rebuild must not replace local history.");
    }
    if (options.mode === "initialize" && options.existingDecisionMarkers !== false) {
      throw new DecisionJournalRefusedError("Missing journal with decision markers; verified comment rebuild required.");
    }
    // Validate the entire completion first. Each durable step is safe to replay
    // after another interruption because the intent binds its exact prefix.
    for (const event of remaining) claim.withOwnership(() => appendJournal(path, event));
  } catch (error) { claim.release(); throw error; }
  let released = false;
  const owned = <T>(action: () => T): T => {
    if (released) throw new DecisionJournalRefusedError("Journal claim already released.");
    return claim.withOwnership(action);
  };
  return {
    path, directory: dirname(path), ownership: claim.ownership,
    withOwnership: owned,
    read: () => owned(() => readDecisionJournal(repository)),
    append: (input: DecisionEventInput): DecisionEvent => owned(() => {
      if (mode === "rebuild") throw new DecisionJournalRefusedError("Use rebuild(comments) to import verified payloads as one validated batch.");
      if (input.rebuild !== undefined || "rebuildBatch" in input) throw new DecisionJournalRefusedError("Only rebuild may adopt comment evidence.");
      const event = parseDecisionEvent({ ...input, schema: DECISION_SCHEMA, at: now().toISOString() });
      const prior = readJournal(path);
      if (!prior.provisioned && event.kind !== "run_started") throw new DecisionJournalRefusedError("Initialize must begin with run_started.");
      const candidate = [...prior.records, event];
      foldDecisionJournal([...candidate, ...pendingDecisionReversalRecords(candidate, prior.tail)], prior.tail);
      verifyEventArtifacts(event);
      // The primitive accepts unknown records and fsyncs; no await separates
      // ownership validation from append, matching the intake execution fence.
      claim.withOwnership(() => appendJournal(path, event));
      return event;
    }),
    rebuild: (comments: readonly VerifiedDecisionComment[]): void => owned(() => {
      if (mode !== "rebuild") throw new DecisionJournalRefusedError("Rebuild requires an explicit rebuild claim.");
      if (readJournal(path).provisioned) throw new DecisionJournalRefusedError("Rebuild must not replace local history.");
      const records = rebuildDecisionRecords(comments);
      if (records.length === 0) throw new DecisionJournalRefusedError("Rebuild requires verified comment payloads.");
      // Publish only a complete, fsynced batch. A crash before rename leaves
      // the journal absent, so a fresh rebuild can retry without adopting a prefix.
      const digest = canonicalJsonSha256(records);
      const batch = records.map((event, index) => ({ ...event, rebuildBatch: { digest, count: records.length, index } }));
      foldDecisionJournal(batch);
      const temporary = join(dirname(path), `.decision-rebuild-${randomUUID()}.jsonl`);
      closeSync(openSync(temporary, "wx", 0o600));
      try {
        for (const event of batch) claim.withOwnership(() => appendJournal(temporary, event));
        claim.withOwnership(() => {
          if (readJournal(path).provisioned) throw new DecisionJournalRefusedError("Rebuild must not replace local history.");
          renameSync(temporary, path);
        });
      } finally { rmSync(temporary, { force: true }); }
    }),
    release: (): void => { if (!released) { claim.release(); released = true; } },
  };
}
