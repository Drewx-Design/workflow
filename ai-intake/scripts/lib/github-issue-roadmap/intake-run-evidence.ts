import { z } from "zod";

import type { IntakeApprovalPlan } from "../../github-issue-roadmap-intake-approve";
import { canonicalJsonSha256, prettyCanonicalJson, sha256Bytes } from "./canonical-json";
import { intakeAssessmentSha256, intakeDispositionSkips, intakeSnapshotCoverageSha256, parseIntakeAssessment } from "./intake-assessment";
import { parseIntakeSnapshotV1, type IntakeSnapshotV1 } from "./intake-snapshot";
import { parseOutcomeEnvelope } from "./outcome-candidate";
import { effectiveOutcomeCandidates, type DispositionHistory } from "./disposition-selection";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
// Evidence files are direct siblings. Reject both Windows and POSIX traversal/ADS paths.
const basename = z.string().min(1).refine((value) =>
  !/[\\/:\x00-\x1f]/.test(value) && value !== "." && value !== ".." && !/[. ]$/.test(value));
const timestamp = z.string().datetime();
// Diagnostic only: the closer re-derives authorship from main's graph. Bind the
// annotation to the exact candidate revision, even in a multi-candidate decision.
const candidateAnnotation = z.object({
  sourceFingerprint: hash, emissionContentSha256: hash, criteriaAuthorship: z.literal("unknown"),
}).strict();
const schema = z.object({
  schemaVersion: z.literal("github-issue-roadmap-intake-run-evidence/v1"),
  runId: z.string().min(1),
  repository: z.string().regex(/^[^\s/\\]+\/[^\s/\\]+$/),
  preparedAt: timestamp,
  approvalPlan: z.object({ path: basename, contentSha256: hash }).strict(),
  census: z.object({
    path: basename, artifactSha256: hash, contentSha256: hash, coverageSha256: hash,
    startedAt: timestamp, bookendCompletedAt: timestamp, issueCount: z.number().int().nonnegative(),
  }).strict(),
  decisions: z.array(z.object({
    decisionPath: basename, decisionContentSha256: hash, candidatePath: basename, candidateSha256: hash,
    snapshotPath: basename, snapshotContentSha256: hash, assessmentPath: basename, assessmentSha256: hash,
    candidateAnnotations: z.array(candidateAnnotation).optional(),
  }).strict()),
}).strict();

export type RunEvidenceV1 = z.infer<typeof schema>;
type RefusalReason = "schema" | "artifact_hash" | "plan_binding" | "census_hash" | "coverage_hash"
  | "census_repository" | "census_chronology" | "decision_missing" | "decision_extra"
  | "candidate_hash" | "snapshot_hash" | "snapshot_census_mismatch" | "assessment_hash"
  | "assessment_binding" | "run_id" | "path_escape" | "dispositioned" | "criteria_authorship";
type Verification = {
  readonly ok: true;
  readonly evidence: RunEvidenceV1;
  readonly artifactSha256: string;
  /** Retain the parsed census for the caller's later reconciliation; verification does no reconciliation. */
  readonly census: IntakeSnapshotV1;
} | { readonly ok: false; readonly reason: RefusalReason; readonly detail: string };

interface NamedBytes { readonly path: string; readonly bytes: Buffer }
interface VerifyOptions {
  readonly evidenceBytes: Buffer;
  readonly plan: IntakeApprovalPlan;
  readonly files: (basename: string) => Buffer | null;
  readonly repository: string;
  readonly runId?: string;
}

/** A retained skip accounts for historical suppression; it can never authorize a plan entry. */
function retainedSkipHistory(envelope: ReturnType<typeof parseOutcomeEnvelope>, value: unknown): DispositionHistory {
  if (value === undefined) return new Map();
  if (!Array.isArray(value)) throw new Error("Skipped entries must be an array.");
  const history = new Map<string, readonly []>();
  const fingerprints = new Set<string>();
  for (const skip of value) {
    const candidate = envelope.candidates.find(candidate => candidate.sourceFingerprint === skip?.sourceFingerprint && candidate.stableOutcomeId === skip?.stableOutcomeId);
    if (candidate === undefined || skip.status !== "dispositioned" || fingerprints.has(candidate.sourceFingerprint)) throw new Error("Invalid retained disposition skip.");
    fingerprints.add(candidate.sourceFingerprint);
    history.set(candidate.stableOutcomeId, []);
  }
  return history;
}

function refusal(reason: RefusalReason, detail: string): Verification {
  return Object.freeze({ ok: false, reason, detail });
}

/** Filesystem callers use this error without exposing a resolved absolute path. */
export class RunEvidencePathEscapeError extends Error {}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function json(bytes: Buffer): unknown { return JSON.parse(bytes.toString("utf8")); }
function localName(path: string): string { return path.replace(/\\/g, "/").split("/").at(-1)!; }
function foldedName(path: string): string { return localName(path).toLowerCase(); }
function repositoryName(snapshot: IntakeSnapshotV1): string {
  return `${snapshot.repository.organization}/${snapshot.repository.name}`.toLowerCase();
}

function censusMaterial(snapshot: IntakeSnapshotV1): string {
  // censusContentSha256 is the stable census identity across candidate rebinding. Compare
  // the material too: the snapshot parser checks the outer digest, not that census digest.
  return canonicalJsonSha256({
    censusContentSha256: snapshot.censusContentSha256, issues: snapshot.issues,
    markerIndex: snapshot.markerIndex, markerIncidents: snapshot.markerIncidents,
    projectObservation: snapshot.projectObservation, receipts: snapshot.receipts,
    census: snapshot.census, coverage: snapshot.coverage,
  });
}

/** Pure verification: callers supply all bytes, including reads of named siblings. */
export function verifyRunEvidence(options: VerifyOptions): Verification {
  let evidence: RunEvidenceV1;
  try { evidence = schema.parse(json(options.evidenceBytes)); }
  catch (error) { return refusal("schema", String(error)); }
  if (options.runId !== undefined && evidence.runId !== options.runId) return refusal("run_id", "Run identity differs.");
  if (Date.parse(evidence.census.bookendCompletedAt) < Date.parse(evidence.census.startedAt)) {
    return refusal("census_chronology", "Census bookend precedes the pass start.");
  }
  const expectedRepository = options.repository.toLowerCase();
  if (evidence.repository.toLowerCase() !== expectedRepository) return refusal("census_repository", "Evidence repository differs.");
  let expected: Map<string, string>;
  try {
    const bindings = options.plan.decisions ?? [options.plan.decision];
    if (bindings.length === 0 || evidence.decisions.length === 0) return refusal("decision_missing", "Plan and evidence must each bind at least one decision.");
    expected = new Map(bindings.map((binding) => [foldedName(binding.path), binding.contentSha256]));
    if (expected.size !== bindings.length) return refusal("plan_binding", "Plan decision basenames are not unique.");
  } catch { return refusal("plan_binding", "Plan decision bindings are invalid."); }
  const seen = new Set<string>();
  for (const decision of evidence.decisions) {
    const name = foldedName(decision.decisionPath);
    if (!expected.has(name) || seen.has(name)) {
      return refusal("decision_extra", `Unexpected or repeated decision: ${decision.decisionPath}`);
    }
    seen.add(name);
  }
  if (seen.size !== expected.size) return refusal("decision_missing", "A plan decision has no evidence binding.");

  // Fold names on every platform: NTFS aliases must never cause a second read.
  const files = new Map<string, Buffer>();
  const names = [evidence.approvalPlan.path, evidence.census.path, ...evidence.decisions.flatMap((entry) =>
    [entry.decisionPath, entry.candidatePath, entry.snapshotPath, entry.assessmentPath])];
  for (const name of names) {
    const key = foldedName(name);
    if (files.has(key)) continue;
    try {
      const bytes = options.files(name);
      if (bytes === null) return refusal("artifact_hash", `Artifact unavailable: ${name}`);
      files.set(key, bytes);
    } catch (error) {
      if (error instanceof RunEvidencePathEscapeError) return refusal("path_escape", name);
      return refusal("artifact_hash", `Artifact unreadable: ${name}`);
    }
  }
  const fileBytes = (name: string) => files.get(foldedName(name))!;
  try {
    if (canonicalJsonSha256(options.plan) !== evidence.approvalPlan.contentSha256 ||
        canonicalJsonSha256(json(fileBytes(evidence.approvalPlan.path))) !== evidence.approvalPlan.contentSha256) {
      return refusal("plan_binding", "Approval plan content differs.");
    }
  } catch { return refusal("plan_binding", "Approval plan is invalid."); }

  const censusBytes = fileBytes(evidence.census.path);
  let census: IntakeSnapshotV1;
  try {
    census = parseIntakeSnapshotV1(json(censusBytes));
    if (sha256Bytes(censusBytes) !== evidence.census.artifactSha256 || census.contentSha256 !== evidence.census.contentSha256 ||
        census.census.issueCount !== evidence.census.issueCount || census.issues.length !== evidence.census.issueCount ||
        census.census.completedAt !== evidence.census.startedAt || census.census.bookendCompletedAt !== evidence.census.bookendCompletedAt) {
      return refusal("census_hash", "Census artifact, content or metadata differs.");
    }
  } catch { return refusal("census_hash", "Census is invalid or its content hash differs."); }
  if (intakeSnapshotCoverageSha256(census) !== evidence.census.coverageSha256) return refusal("coverage_hash", "Census coverage differs.");
  if (repositoryName(census) !== expectedRepository) return refusal("census_repository", "Census repository differs.");
  for (const entry of evidence.decisions) {
    const decisionBytes = fileBytes(entry.decisionPath);
    if (entry.decisionContentSha256 !== expected.get(foldedName(entry.decisionPath)) || sha256Bytes(decisionBytes) !== entry.decisionContentSha256) {
      return refusal("plan_binding", `Decision content differs: ${entry.decisionPath}`);
    }
    let candidate: ReturnType<typeof parseOutcomeEnvelope>;
    try {
      candidate = parseOutcomeEnvelope(json(fileBytes(entry.candidatePath)));
      if (canonicalJsonSha256(candidate) !== entry.candidateSha256) return refusal("candidate_hash", entry.candidatePath);
    } catch { return refusal("candidate_hash", entry.candidatePath); }
    const annotated = new Set<string>();
    for (const annotation of entry.candidateAnnotations ?? []) {
      const outcome = candidate.candidates.find(outcome => outcome.sourceFingerprint === annotation.sourceFingerprint &&
        outcome.emissionContentSha256 === annotation.emissionContentSha256);
      if (!outcome?.acceptanceCriteria?.length || annotated.has(annotation.sourceFingerprint)) {
        return refusal("criteria_authorship", "Authorship annotation must bind one criteria-bearing candidate revision.");
      }
      annotated.add(annotation.sourceFingerprint);
    }
    let snapshot: IntakeSnapshotV1;
    try {
      snapshot = parseIntakeSnapshotV1(json(fileBytes(entry.snapshotPath)));
      if (snapshot.contentSha256 !== entry.snapshotContentSha256) return refusal("snapshot_hash", entry.snapshotPath);
    } catch { return refusal("snapshot_hash", entry.snapshotPath); }
    if (repositoryName(snapshot) !== expectedRepository || snapshot.repository.databaseId !== census.repository.databaseId ||
        snapshot.repository.nodeId !== census.repository.nodeId) return refusal("census_repository", entry.snapshotPath);
    if (censusMaterial(snapshot) !== censusMaterial(census)) return refusal("snapshot_census_mismatch", entry.snapshotPath);
    let assessmentValue: unknown;
    try {
      assessmentValue = json(fileBytes(entry.assessmentPath));
    } catch { return refusal("assessment_hash", entry.assessmentPath); }
    try {
      const report = json(decisionBytes) as { decision?: Record<string, unknown>; skipped?: unknown; assessmentInputSha256?: string };
      if (canonicalJsonSha256(assessmentValue) !== (report.assessmentInputSha256 ?? entry.assessmentSha256)) return refusal("assessment_hash", entry.assessmentPath);
      const history = retainedSkipHistory(candidate, report.skipped);
      const selection = effectiveOutcomeCandidates(candidate, history);
      const skipped = intakeDispositionSkips(candidate, history);
      if (canonicalJsonSha256(report.skipped ?? []) !== canonicalJsonSha256(skipped) ||
          canonicalJsonSha256(report.decision?.skipped ?? []) !== canonicalJsonSha256(skipped)) return refusal("dispositioned", "Skipped decision accounting differs.");
      const dispositioned = new Set(selection.dispositioned.map(candidate => candidate.sourceFingerprint));
      if (options.plan.entries.some(planEntry => foldedName(planEntry.decisionReport.path) === foldedName(entry.decisionPath) && dispositioned.has(planEntry.sourceFingerprint))) return refusal("dispositioned", "Approval binds a dispositioned candidate.");
      const assessment = parseIntakeAssessment(assessmentValue, candidate, snapshot, undefined, history);
      if (intakeAssessmentSha256(assessment) !== entry.assessmentSha256) return refusal("assessment_hash", entry.assessmentPath);
      if (report.decision?.candidateSha256 !== entry.candidateSha256 ||
          report.decision.snapshotContentSha256 !== entry.snapshotContentSha256 ||
          report.decision.assessmentSha256 !== entry.assessmentSha256) {
        return refusal("assessment_binding", `Decision does not bind its assessment inputs: ${entry.decisionPath}`);
      }
    } catch { return refusal("assessment_binding", entry.assessmentPath); }
  }
  return deepFreeze({ ok: true, evidence, census, artifactSha256: sha256Bytes(options.evidenceBytes) } as const);
}

/** Build and verify from the caller's retained bytes; never reads or writes the filesystem. */
export function buildRunEvidence(input: {
  readonly runId: string; readonly repository: string; readonly preparedAt: string;
  readonly approvalPlan: NamedBytes; readonly census: NamedBytes;
  readonly decisions: readonly {
    readonly decision: NamedBytes; readonly candidate: NamedBytes; readonly snapshot: NamedBytes; readonly assessment: NamedBytes;
    readonly candidateAnnotations?: readonly z.infer<typeof candidateAnnotation>[];
  }[];
}): Verification {
  try {
    const files = new Map<string, Buffer>();
    for (const file of [input.approvalPlan, input.census, ...input.decisions.flatMap((entry) =>
      [entry.decision, entry.candidate, entry.snapshot, entry.assessment])]) {
      const key = foldedName(file.path);
      if (files.has(key) && !files.get(key)!.equals(file.bytes)) return refusal("artifact_hash", `Conflicting artifact: ${file.path}`);
      files.set(key, file.bytes);
    }
    const plan = json(input.approvalPlan.bytes) as IntakeApprovalPlan;
    const census = parseIntakeSnapshotV1(json(input.census.bytes));
    const evidence: RunEvidenceV1 = {
      schemaVersion: "github-issue-roadmap-intake-run-evidence/v1", runId: input.runId,
      repository: input.repository, preparedAt: input.preparedAt,
      approvalPlan: { path: input.approvalPlan.path, contentSha256: canonicalJsonSha256(plan) },
      census: {
        path: input.census.path, artifactSha256: sha256Bytes(input.census.bytes), contentSha256: census.contentSha256,
        coverageSha256: intakeSnapshotCoverageSha256(census), startedAt: census.census.completedAt,
        bookendCompletedAt: census.census.bookendCompletedAt, issueCount: census.census.issueCount,
      },
      decisions: input.decisions.map(({ decision, candidate, snapshot, assessment, candidateAnnotations }) => ({
        decisionPath: decision.path, decisionContentSha256: sha256Bytes(decision.bytes),
        candidatePath: candidate.path, candidateSha256: canonicalJsonSha256(parseOutcomeEnvelope(json(candidate.bytes))),
        snapshotPath: snapshot.path, snapshotContentSha256: parseIntakeSnapshotV1(json(snapshot.bytes)).contentSha256,
        assessmentPath: assessment.path, assessmentSha256: intakeAssessmentSha256(parseIntakeAssessment(
          json(assessment.bytes), parseOutcomeEnvelope(json(candidate.bytes)), parseIntakeSnapshotV1(json(snapshot.bytes)), undefined,
          retainedSkipHistory(parseOutcomeEnvelope(json(candidate.bytes)), (json(decision.bytes) as { skipped?: unknown }).skipped),
        )),
        ...(candidateAnnotations === undefined ? {} : { candidateAnnotations: [...candidateAnnotations] }),
      })),
    };
    return verifyRunEvidence({ evidenceBytes: Buffer.from(prettyCanonicalJson(evidence)), plan,
      files: (name) => files.get(foldedName(name)) ?? null, repository: input.repository, runId: input.runId });
  } catch (error) { return refusal("schema", String(error)); }
}
