import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { z } from "zod";

import { canonicalJsonSha256 } from "./canonical-json";
import { activeOutcomeCandidates, createOutcomeEnvelope } from "./outcome-candidate";

export const INTAKE_DRAIN_ADMISSION_SCHEMA = "github-issue-roadmap-intake-drain-admission/v2" as const;
const LEGACY_ADMISSION_SCHEMA = "github-issue-roadmap-intake-drain-admission/v1" as const;

const text = z.string().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const localPath = text.refine((path) => !isAbsolute(path) && !path.includes("\\") &&
  !path.includes(":") && path !== ".." && !path.startsWith("../") && posix.normalize(path) === path,
"Admission paths must be normalized repository-relative paths.");
const repository = z.object({ organization: text, name: text, databaseId: z.number().int().positive(), nodeId: text });
const suggestion = z.object({ value: z.unknown(), confidence: z.unknown(), rationale: z.unknown() });
// These are diagnostic Git names, not filesystem authority. In particular,
// unrelated filenames need not satisfy the admission material's locator rules.
const treeChange = z.object({ path: text, status: text });
const admissionTreeSchema = z.object({
  commitSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  admissionRelevantPaths: z.array(text),
  admissionClean: z.boolean(),
  allowDirtyAdmission: z.boolean(),
  scheduleEquivalent: z.boolean(),
  relevantChanges: z.array(treeChange),
  unrelatedChanges: z.array(treeChange),
});
export type IntakeAdmissionTree = z.infer<typeof admissionTreeSchema>;

// Project known envelope fields before using the strict envelope validator. Unknown additions at
// any depth are ignored; all existing material semantics still use the canonical validator.
const envelopeMaterial = z.object({
  schemaVersion: z.unknown(), repository,
  producer: z.object({ kind: z.unknown(), version: z.unknown() }),
  artifact: z.object({ stableId: z.unknown(), revisionSha256: z.unknown(), sourceLocator: z.unknown() }),
  candidates: z.array(z.object({
    stableOutcomeId: z.unknown(),
    disposition: z.unknown().optional(),
    acceptanceCriteria: z.unknown().optional(),
    startCommand: z.unknown().optional(),
    outcome: z.object({ title: z.unknown(), completionRule: z.unknown(), affectedSystems: z.unknown() }),
    evidence: z.array(z.object({ id: z.unknown(), kind: z.unknown(), sourceLocator: z.unknown(), contentSha256: z.unknown() })),
    provenance: z.array(z.object({ id: z.unknown(), sourceLocator: z.unknown(), contentSha256: z.unknown() })),
    readiness: z.object({
      independentlyCloseable: z.unknown(), framingComplete: z.unknown(), completionRuleDefined: z.unknown(),
      evidenceSufficient: z.unknown(), estimationSubstrate: z.unknown(), unresolvedDecisionIds: z.unknown(),
      dependencyIds: z.unknown(), currentMainVerificationEvidenceId: z.unknown(),
    }),
    relationshipCandidates: z.array(z.object({ kind: z.unknown(), targetIssueNumber: z.unknown(), evidenceIds: z.unknown() })),
    suggestions: z.object({ type: suggestion, priority: suggestion, effort: suggestion }),
  })).min(1),
}).transform((value) => {
  const envelope = createOutcomeEnvelope(value);
  return {
    ...envelope,
    candidates: envelope.candidates.map(({ sourceFingerprint: _fingerprint, emissionContentSha256: _emission, ...material }) => material),
  };
});

const admissionSchema = z.object({
  schema: z.enum([INTAKE_DRAIN_ADMISSION_SCHEMA, LEGACY_ADMISSION_SCHEMA]),
  firstAttemptAt: z.string().datetime().optional(),
  runId: text, queueIdentity: hash, preparedAt: z.string().datetime(), queueDirectory: localPath,
  // Optional for legacy receipts. Preserve the original observation on recovery;
  // neither queue identity nor U2.C's plan/census binding hashes this diagnostic.
  admissionTree: admissionTreeSchema.optional(),
  queueEntries: z.array(z.object({
    path: localPath, contentSha256: hash, sourceLocator: localPath,
    declaredProducerKind: text, producerKind: text,
    correction: z.object({ from: text, to: text }).nullable(), sourceFingerprints: z.array(hash).min(1).readonly(),
  })).min(1),
  stack: z.object({ path: localPath, sha256: hash, contentBase64: z.string().optional() }),
  envelopes: z.array(z.object({ envelope: envelopeMaterial, queueEntryIndexes: z.array(z.number().int().nonnegative()).min(1) })).min(1),
  repository,
  quarantinedEntries: z.array(z.object({
    originalPath: localPath, quarantinedPath: localPath, reasonPath: localPath, reason: text,
  })),
}).refine((record) => record.schema === LEGACY_ADMISSION_SCHEMA || record.stack.contentBase64 !== undefined,
  "V2 admissions must retain the stack bytes.");

const abandonedIntakeAdmissionSchema = z.object({
  runId: text, originalPath: localPath, quarantinedPath: localPath, reasonPath: localPath, reason: text,
  sidecars: z.array(z.object({ originalPath: localPath, quarantinedPath: localPath })).default([]),
});

export type IntakeDrainAdmission = z.infer<typeof admissionSchema>;
export type RunState = { readonly runId: string; readonly runDir: string } & (
  | { readonly status: "empty" }
  | { readonly status: "unfinished"; readonly admission: IntakeDrainAdmission }
  | { readonly status: "finished" }
  | { readonly status: "abandoned"; readonly receipt: z.infer<typeof abandonedIntakeAdmissionSchema>; readonly reason: string }
  | { readonly status: "corrupt"; readonly reason: string }
);
export interface AdmissionTarget {
  readonly repoRoot: string;
  readonly queueDirectory: string;
  readonly stackPath: string;
  readonly repository: string;
}

/** Check both lexical containment and existing ancestors (including junctions/symlinks). */
export function assertPathWithin(root: string, path: string): void {
  const inside = (base: string, target: string) => {
    const rel = relative(resolve(base), resolve(target));
    return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\");
  };
  if (!inside(root, path)) throw new Error(`Path must remain inside ${root}: ${path}`);
  let ancestor = resolve(path);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  let rootAncestor = resolve(root);
  while (!existsSync(rootAncestor)) rootAncestor = dirname(rootAncestor);
  const physicalRoot = resolve(realpathSync(rootAncestor), relative(rootAncestor, resolve(root)));
  const physicalPath = resolve(realpathSync(ancestor), relative(ancestor, resolve(path)));
  if (!inside(physicalRoot, physicalPath)) throw new Error(`Path escapes through a symlink: ${path}`);
}

// Admission records are unauthenticated local state. Every queueIdentity input is in
// the record: validateIdentity proves internal consistency, NOT authenticity or authorship.
// Configured repository/path bounds constrain authority even when all sidecars are gone.
// sourceLocator and envelope evidence/provenance locators are retained descriptive material,
// never filesystem authority on resume. stack.path is bound to the caller-configured stack;
// all sidecar and diagnostic paths are bounded to the configured queue or run directory.
function validateIdentity(record: IntakeDrainAdmission, directoryName: string): void {
  const expected = canonicalJsonSha256({
    queue: record.queueEntries.map((entry) => ({ path: entry.path, sha256: entry.contentSha256 })),
    stack: { path: record.stack.path, sha256: record.stack.sha256 },
  });
  if (expected !== record.queueIdentity || record.runId !== `d-${expected.slice(0, 12)}` || record.runId !== directoryName) {
    throw new Error("Admission run identity disagrees with its retained inputs.");
  }
  const covered = new Set<number>();
  const fingerprints = new Set<string>();
  for (const { envelope, queueEntryIndexes } of record.envelopes) {
    if (canonicalJsonSha256(envelope.repository) !== canonicalJsonSha256(record.repository)) {
      throw new Error("Admission repository disagrees with its envelopes.");
    }
    const regenerated = createOutcomeEnvelope(envelope);
    const members = new Set<string>();
    for (const index of queueEntryIndexes) {
      const entry = record.queueEntries[index];
      if (entry === undefined) throw new Error("Admission envelope references an unknown queue entry.");
      covered.add(index);
      entry.sourceFingerprints.forEach((fingerprint) => members.add(fingerprint));
    }
    const selection = activeOutcomeCandidates(regenerated);
    for (const candidate of [...selection.active, ...selection.dispositioned]) {
      if (!members.has(candidate.sourceFingerprint) || fingerprints.has(candidate.sourceFingerprint)) {
        throw new Error("Admission queue membership disagrees with its candidate material.");
      }
      fingerprints.add(candidate.sourceFingerprint);
    }
  }
  if (covered.size !== record.queueEntries.length || record.queueEntries.some((entry) =>
    entry.sourceFingerprints.some((fingerprint) => !fingerprints.has(fingerprint)))) {
    throw new Error("Admission has unaccounted queue entries or candidates.");
  }
}

/** Unfinished means preparation has not committed its manifest, not collection pending.
 * Per-run damage is data; only the inventory's root read can make the fleet unavailable.
 * Prepare and holds share this artifact state model. Attempt marker contents are
 * diagnostic evidence; counting their names never depends on reading their bytes.
 */
export function classifyRun(runDir: string, target?: AdmissionTarget): RunState {
  if (!existsSync(runDir) && existsSync(`${runDir}.quarantine`)) runDir = `${runDir}.quarantine`;
  const quarantineSuffix = /\.quarantine(?:-[a-f0-9-]{36})?$/;
  const base = { runId: basename(runDir).replace(quarantineSuffix, ""), runDir };
  try {
    // Do not follow a run-directory symlink outside the drains root.
    assertPathWithin(dirname(runDir), runDir);
    const read = (name: string): unknown => {
      const path = join(runDir, name);
      assertPathWithin(runDir, path);
      return JSON.parse(readFileSync(path, "utf8"));
    };
    let receiptError: unknown;
    // A receipt can precede relocation indefinitely (for example, a scanner
    // holding the directory open). Occupied quarantines belong to older runs.
    const pendingReceipts = quarantineSuffix.test(runDir) ? [] : readdirSync(dirname(runDir))
      .filter((name) => name.startsWith(`${base.runId}.quarantine`) && name.endsWith(".abandoned.json"))
      .filter((name) => quarantineSuffix.test(name.slice(0, -".abandoned.json".length)))
      .map((name) => join(dirname(runDir), name))
      .filter((path) => !existsSync(path.slice(0, -".abandoned.json".length)));
    for (const receiptPath of [`${runDir}.abandoned.json`, join(runDir, "abandoned.json"), ...pendingReceipts]) {
      if (!existsSync(receiptPath)) continue;
      try {
        assertPathWithin(dirname(runDir), receiptPath);
        const receipt = abandonedIntakeAdmissionSchema.parse(JSON.parse(readFileSync(receiptPath, "utf8")));
        if (receipt.runId !== base.runId) throw new Error("Abandoned receipt run identity disagrees.");
        const repoRoot = resolve(runDir, "../../../..");
        const originalRun = join(dirname(runDir), base.runId);
        if (resolve(repoRoot, receipt.originalPath) !== join(originalRun, "admission.json")) {
          throw new Error("Abandoned receipt original path disagrees with run identity.");
        }
        const evidencePath = resolve(repoRoot, receipt.quarantinedPath);
        if (pendingReceipts.includes(receiptPath)) {
          if (evidencePath !== join(receiptPath.slice(0, -".abandoned.json".length), "admission.json")) {
            throw new Error("Abandoned receipt destination disagrees with receipt identity.");
          }
          receipt.quarantinedPath = receipt.originalPath;
        } else {
          assertPathWithin(runDir, evidencePath);
        }
        for (const path of [receipt.reasonPath, ...receipt.sidecars.map((entry) => entry.quarantinedPath)]) {
          assertPathWithin(dirname(runDir), resolve(repoRoot, path));
        }
        let reason = receipt.reason;
        try { reason = readFileSync(resolve(repoRoot, receipt.reasonPath), "utf8"); }
        catch { /* The committed receipt contains the reason; this file is optional. */ }
        return { ...base, status: "abandoned", receipt, reason };
      } catch (error) { receiptError = error; }
    }
    const names = readdirSync(runDir);
    let admission: IntakeDrainAdmission | undefined;
    if (names.includes("admission.json")) {
      admission = admissionSchema.parse(read("admission.json"));
      validateIdentity(admission, base.runId);
      if (target !== undefined) {
        if (`${admission.repository.organization}/${admission.repository.name}` !== target.repository) {
          throw new Error("Admission repository differs from configured target.");
        }
        if (resolve(target.repoRoot, admission.queueDirectory) !== resolve(target.queueDirectory)) {
          throw new Error("Admission queue directory differs from configured queue.");
        }
        for (const entry of admission.queueEntries) {
          const path = resolve(target.repoRoot, entry.path);
          assertPathWithin(target.queueDirectory, path);
          if (dirname(path) !== resolve(target.queueDirectory) || !path.endsWith(".json")) {
            throw new Error("Admission sidecar must be a direct JSON child of the configured queue.");
          }
        }
        // Retained v2 bytes do not read this path, but it must still name the configured stack.
        if (resolve(target.repoRoot, admission.stack.path) !== resolve(target.stackPath)) {
          throw new Error("Admission stack differs from configured stack.");
        }
        for (const entry of admission.quarantinedEntries) {
          assertPathWithin(target.queueDirectory, resolve(target.repoRoot, entry.originalPath));
          assertPathWithin(target.queueDirectory, resolve(target.repoRoot, entry.quarantinedPath));
          assertPathWithin(target.queueDirectory, resolve(target.repoRoot, entry.reasonPath));
        }
      }
    }
    if (quarantineSuffix.test(runDir) && admission !== undefined) {
      const repoRoot = resolve(runDir, "../../../..");
      const local = (path: string) => relative(repoRoot, path).replace(/\\/g, "/");
      let reason = "Admission abandonment committed by directory rename; receipt unavailable.";
      const reasonPath = `${runDir}.reason.txt`;
      try {
        assertPathWithin(dirname(runDir), reasonPath);
        reason = readFileSync(reasonPath, "utf8").trim() || reason;
      } catch { /* Optional diagnostics cannot undo the committed rename. */ }
      return { ...base, status: "abandoned", reason, receipt: {
        runId: base.runId, originalPath: local(join(dirname(runDir), base.runId, "admission.json")),
        quarantinedPath: local(join(runDir, "admission.json")), reasonPath: local(reasonPath), reason, sidecars: [],
      } };
    }
    if (receiptError !== undefined) throw receiptError;
    if (names.includes("manifest.json")) {
      const manifest = z.object({ schemaVersion: z.literal("github-issue-roadmap-intake-drain/v1"),
        runId: text, envelopes: z.array(z.unknown()) }).parse(read("manifest.json"));
      if (manifest.runId !== base.runId || (admission !== undefined && manifest.envelopes.length !== admission.envelopes.length)) {
        throw new Error("Manifest disagrees with run identity or admitted envelopes.");
      }
      return { ...base, status: "finished" };
    }
    if (admission !== undefined) return { ...base, status: "unfinished", admission };
    return { ...base, status: "empty" };
  } catch (error) {
    return { ...base, status: "corrupt", reason: error instanceof Error ? error.message : String(error) };
  }
}

export function readIntakeRuns(drainsRoot: string, target?: AdmissionTarget):
  | { readonly status: "available"; readonly runs: readonly RunState[] }
  | { readonly status: "unavailable"; readonly runs: null; readonly reason: "absent" | "unreadable" } {
  let runs;
  try { runs = readdirSync(drainsRoot, { withFileTypes: true }); }
  catch (error) {
    return { status: "unavailable", runs: null, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable" };
  }
  return { status: "available", runs: runs.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name)).map((run) => classifyRun(join(drainsRoot, run.name), target)) };
}

export class TerminalAdmissionError extends Error {}
export class TransientAdmissionError extends Error {}

/** Flush temporary bytes before publication, then flush the parent directory.
 * Platforms without directory fsync retain process-crash atomicity, but cannot
 * guarantee rename durability across power loss. A sibling temporary name is
 * never an admitted artifact or persistent claim. */
export function atomicDrainWrite(path: string, content: string | Buffer): void {
  const temporaryPath = join(dirname(path), `.tmp-${randomUUID()}-${basename(path)}`);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporaryPath, content, { flag: "wx", mode: 0o600 });
    const file = openSync(temporaryPath, "r+");
    try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(temporaryPath, path);
    let directory: number | undefined;
    try {
      directory = openSync(dirname(path), "r");
      fsyncSync(directory);
    } catch (error) {
      // Windows may refuse directory handles; other filesystems reject directory fsync.
      const code = (error as NodeJS.ErrnoException).code;
      if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EISDIR"].includes(code ?? "") &&
          !(process.platform === "win32" && ["EPERM", "EACCES"].includes(code ?? ""))) throw error;
    } finally {
      if (directory !== undefined) closeSync(directory);
    }
  } catch (error) {
    throw new TransientAdmissionError(`Atomic write failed for ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    try { if (existsSync(temporaryPath)) unlinkSync(temporaryPath); }
    catch { /* A crash or failed cleanup leaves only an unpublished temporary artifact. */ }
  }
}
