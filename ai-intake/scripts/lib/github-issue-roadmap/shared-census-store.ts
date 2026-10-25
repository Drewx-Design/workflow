import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

import { canonicalJsonSha256, prettyCanonicalJson } from "./canonical-json";
import { parseBoardFingerprint, type BoardFingerprint } from "./board-fingerprint";
import { resolveJournalPath, type ExecutionClaim } from "./intake-execution-journal";
import { buildIntakeSnapshot, parseIntakeSnapshotV1, type IntakeSnapshotV1, type IntakeCensusPass } from "./intake-snapshot";
import type { IntakeIssueIndex } from "../../github-issue-roadmap-intake-preflight";
import { parseCanonicalSnapshotV2, type CanonicalSnapshotV2 } from "./snapshot-v2";

export type SerializedIntakeIssueIndex = Omit<IntakeIssueIndex, "updatedAt"> & {
  readonly updatedAt: Readonly<Record<string, string>>;
};

interface SharedCensusBase {
  readonly repository: IntakeSnapshotV1["repository"];
  readonly publishedAt: string;
  readonly canonicalSnapshot: CanonicalSnapshotV2;
  readonly intakeSnapshot: IntakeSnapshotV1;
  readonly boardFingerprint: BoardFingerprint;
  /** Zero records use the explicit "empty" sentinel; otherwise hash the last record. */
  readonly journalPosition: { readonly recordCount: number; readonly lastRecordSha256: string };
}

export type SharedCensusBundle = SharedCensusBase & (
  | { readonly schemaVersion: "github-issue-roadmap-shared-census/v2" }
  | { readonly schemaVersion: "github-issue-roadmap-shared-census/v3";
      readonly intakePass: IntakeCensusPass; readonly intakeBookend: SerializedIntakeIssueIndex }
);

// Resolve existing ancestors as well as the file itself, including junctions.
function realPath(path: string): string {
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(realPath(dirname(path)), basename(path));
  }
  return realpathSync(path);
}

/** The census is a sibling of the journal, never a worktree artifact. */
export function assertSharedCensusPath(repository: string, claim: ExecutionClaim): string {
  return claim.withOwnership(() => {
    const directory = dirname(resolveJournalPath(repository));
    const path = join(directory, "census", "bundle.json");
    const contained = relative(realpathSync(directory), realPath(path));
    if (contained === "" || contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
      throw new Error("Shared census must resolve inside the repository journal directory.");
    }
    return path;
  });
}

export function parseSharedCensusBundle(value: unknown, repository: IntakeSnapshotV1["repository"]): SharedCensusBundle {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid shared census bundle.");
  const bundle = value as SharedCensusBundle;
  if (!["github-issue-roadmap-shared-census/v2", "github-issue-roadmap-shared-census/v3"].includes(bundle.schemaVersion) ||
      typeof bundle.publishedAt !== "string" || !Number.isFinite(Date.parse(bundle.publishedAt))) {
    throw new Error("Invalid shared census version or publication time.");
  }
  const intake = parseIntakeSnapshotV1(bundle.intakeSnapshot);
  const canonical = parseCanonicalSnapshotV2(bundle.canonicalSnapshot);
  const fingerprint = parseBoardFingerprint(bundle.boardFingerprint);
  const position = bundle.journalPosition;
  if (!position || !Number.isSafeInteger(position.recordCount) || position.recordCount < 0 ||
      (position.recordCount === 0 ? position.lastRecordSha256 !== "empty" : !/^[a-f0-9]{64}$/.test(position.lastRecordSha256))) {
    throw new Error("Invalid shared census journal position.");
  }
  const identity = canonicalJsonSha256(repository);
  if ([bundle.repository, intake.repository, canonical.repository].some(item => canonicalJsonSha256(item) !== identity) ||
      intake.canonicalSnapshotV2Sha256 !== canonicalJsonSha256(canonical) ||
      fingerprint.repositoryFullName !== `${repository.organization}/${repository.name}`) {
    throw new Error("Shared census repository or canonical snapshot binding mismatch.");
  }
  if (bundle.schemaVersion === "github-issue-roadmap-shared-census/v3") {
    const pass = bundle.intakePass;
    const bookend = bundle.intakeBookend;
    if (!pass || !bookend || !bookend.updatedAt || typeof bookend.updatedAt !== "object" ||
        Array.isArray(bookend.updatedAt) || bookend.updatedAt instanceof Map || !Array.isArray(bookend.receipts) ||
        !Number.isSafeInteger(bookend.excludedPullRequestCount) || bookend.excludedPullRequestCount < 0 ||
        !Number.isFinite(Date.parse(bookend.completedAt)) || Date.parse(bookend.completedAt) < Date.parse(pass.completedAt) ||
        Object.entries(bookend.updatedAt).some(([key, value]) => !/^[1-9]\d*$/.test(key) ||
          !Number.isSafeInteger(Number(key)) || typeof value !== "string" || !Number.isFinite(Date.parse(value))) ||
        canonicalJsonSha256(bookend.updatedAt) !== canonicalJsonSha256(Object.fromEntries(pass.issues.map(issue => [issue.number, issue.updatedAt])))) {
      throw new Error("Invalid shared census raw pass or bookend.");
    }
    const rebuilt = buildIntakeSnapshot({ candidateSha256: intake.candidateSha256,
      canonicalSnapshotV2Sha256: intake.canonicalSnapshotV2Sha256, generatedAt: intake.generatedAt,
      pass, bookend, projectObservation: intake.projectObservation });
    if (canonicalJsonSha256(rebuilt) !== canonicalJsonSha256(intake)) {
      throw new Error("Shared census raw pass does not reproduce its intake snapshot.");
    }
  }
  return bundle;
}

export function readSharedCensus(repository: IntakeSnapshotV1["repository"], claim: ExecutionClaim): SharedCensusBundle | undefined {
  return claim.withOwnership(() => {
    // Containment and ownership refusals are not cache misses.
    const path = assertSharedCensusPath(`${repository.organization}/${repository.name}`, claim);
    try { return parseSharedCensusBundle(JSON.parse(readFileSync(path, "utf8")), repository); }
    catch { return undefined; }
  });
}

export function publishSharedCensus(repository: string, claim: ExecutionClaim, bundle: SharedCensusBundle): void {
  claim.withOwnership(() => {
    const path = assertSharedCensusPath(repository, claim);
    parseSharedCensusBundle(bundle, bundle.repository);
    if (`${bundle.repository.organization}/${bundle.repository.name}`.toLowerCase() !== repository.toLowerCase()) {
      throw new Error("Shared census repository differs from its journal.");
    }
    mkdirSync(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, prettyCanonicalJson(bundle), { encoding: "utf8", flag: "wx" });
      for (let attempt = 0; ; attempt++) {
        try { renameSync(temporaryPath, path); break; }
        catch (error) {
          if (attempt >= 2 || !["EPERM", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch { /* Preserve the publication failure; leftover temps are ignored. */ }
      throw error;
    }
  });
}
