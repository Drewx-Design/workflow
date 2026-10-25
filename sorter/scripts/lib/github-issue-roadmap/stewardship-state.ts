import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { join, resolve, toNamespacedPath } from "node:path";
import { z } from "zod";
import { canonicalJson, canonicalJsonSha256, readVerifiedImmutableJson, sha256Bytes } from "./canonical-json";
import { createStewardshipArtifactCache, type StewardshipArtifactCache } from "./stewardship-artifacts";
import { acquireHostRepositoryLock, defaultHostRoadmapControlRoot, hostRepositoryLockPort } from "./host-lock";
import { createWindowsPrivateDirectoryAclController } from "./windows-private-directory-acl";
import { parseStewardshipPolicy, resolveStewardshipPolicy, stewardshipTimeoutRetries, validateStewardshipPolicyChange, stewardshipHashSchema as hash, stewardshipHorizonSchema, stewardshipOperationSchema, stewardshipPolicySha256, stewardshipPrioritySchema, type StewardshipOperation, type StewardshipPolicy } from "./stewardship-policy";
import { stewardshipPacketMaterialSha256, type StewardshipIssueEvidencePacket } from "./stewardship-evidence";
import { stewardshipAssessmentEnvelopeSchema, type StewardshipAssessmentEnvelope, type StewardshipRejectedAnswer } from "./stewardship-assessment";
import { isStewardshipDiagnosticMethod, type StewardshipDiagnostic } from "./stewardship-diagnostics";
import { sameStewardshipSeatFamilies, STEWARDSHIP_DIVERGENCE_KEYS } from "./stewardship-decision";
import { STEWARDSHIP_SEAT_FAMILIES, type StewardshipSeatFamilies } from "./stewardship-seat-families";
import { compileStewardshipBacklog, stewardshipSnapshotOperations } from "./stewardship-backlog";
import { isSnapshotStewardshipPolicy, STEWARDSHIP_NATIVE_FIELDS, stewardshipLifecycleSchema, stewardshipSortKeySchema, stewardshipOperationField, stewardshipOperationValue, stewardshipWritableFields, stewardshipPolicyUpgradePreservesAssessments, validateStewardshipPolicyUpgrade, type StewardshipNativeField } from "./stewardship-policy";
import { validateStewardshipProjectionGates } from "./stewardship-projection";
import type { StewardshipObservation } from "./stewardship-github";

const id = z.string().min(1).max(256).regex(/^[a-zA-Z0-9_.:-]+$/)
  .refine((value) => !Object.hasOwn(Object.prototype, value), "Reserved local identifier");
const nativeEventId = z.string().min(1).max(512);
const instant = z.string().datetime({ offset: true });
const issueNumber = z.number().int().positive().safe();
const lifecycleReceiptSchema = z.object({
  issueNumber, value: stewardshipLifecycleSchema.nullable(), snapshotSha256: hash, assessedUpdatedAt: instant,
  evidenceIdentity: z.object({ packetSha256: hash, materialEvidenceSha256: hash }).strict(),
  fieldEvent: z.object({ id: nativeEventId, actor: z.string().min(1), createdAt: instant }).strict(), confirmedAt: instant,
}).strict();
export type StewardshipLifecycleReceipt = z.infer<typeof lifecycleReceiptSchema>;
interface LifecycleObservation { issueNumber: number; compileSnapshotSha256: string; compiledAt: string;
  lifecycleTarget: "Done candidate" | "Stale candidate" | "empty" | "hold" }
const lifecycleTargetSchema = z.enum(["Done candidate", "Stale candidate", "empty", "hold"]);
const field = z.enum([...STEWARDSHIP_NATIVE_FIELDS, "Sort key"]);
const effortValue = z.string().min(1).max(100);
const fieldValue = z.union([stewardshipPrioritySchema, stewardshipHorizonSchema, effortValue, stewardshipSortKeySchema, z.null()]);
const seatFamily = z.enum(STEWARDSHIP_SEAT_FAMILIES);
const tokenCount = z.number().int().nonnegative().safe();
export const stewardshipCallUsageSchema = z.union([z.literal("unknown"), z.object({
  inputTokens: tokenCount, cachedInputTokens: tokenCount, uncachedInputTokens: tokenCount, outputTokens: tokenCount,
}).strict().refine((usage) => usage.cachedInputTokens + usage.uncachedInputTokens === usage.inputTokens)]);
const issueUsageSchema = z.object({
  seats: z.array(z.object({ seat: seatFamily, phase: z.enum(["initial", "expanded"]),
    attempt: z.number().int().min(1).max(2), usage: stewardshipCallUsageSchema }).strict()).max(8),
  scout: stewardshipCallUsageSchema.optional(),
}).strict();
export type StewardshipIssueUsage = z.infer<typeof issueUsageSchema>;
const compilerProvenance = { compilerVersion: z.number().int().optional(), seatFamilies: z.tuple([seatFamily, seatFamily]).optional() };
interface CompilerProvenance { compilerVersion?: number; seatFamilies?: StewardshipSeatFamilies }
function eventCompilerProvenance(event: CompilerProvenance): CompilerProvenance {
  return { ...(event.compilerVersion === undefined ? {} : { compilerVersion: event.compilerVersion }),
    ...(event.seatFamilies === undefined ? {} : { seatFamilies: event.seatFamilies }) };
}
/** Historical evidence requires these fields; Effort remains optional when replaying old packets. */
export type StewardshipField = "Priority" | "Horizon";
export type StewardshipFieldValue = z.infer<typeof fieldValue>;
export const stewardshipFrontierSchema = z.object({
  complete: z.boolean(), eventIds: z.array(nativeEventId), cursor: z.string().nullable(),
}).strict().refine((value) => new Set(value.eventIds).size === value.eventIds.length, "Duplicate field event IDs");
export type StewardshipFrontier = z.infer<typeof stewardshipFrontierSchema>;
export const stewardshipBaselineSchema = z.object({
  issueNumber, materialEvidenceSha256: hash,
  fields: z.object({ Priority: stewardshipPrioritySchema.nullable(), Horizon: stewardshipHorizonSchema.nullable(), Effort: effortValue.nullable().optional(), Lifecycle: stewardshipLifecycleSchema.nullable().optional(), "Sort key": stewardshipSortKeySchema.nullable().optional() }).strict(),
  // Event IDs and cursors are scoped to each native field, including at adoption.
  frontiers: z.object({ Priority: stewardshipFrontierSchema, Horizon: stewardshipFrontierSchema, Effort: stewardshipFrontierSchema.optional(), Lifecycle: stewardshipFrontierSchema.optional(), "Sort key": stewardshipFrontierSchema.optional() }).strict(),
}).strict();
export type StewardshipBaseline = z.infer<typeof stewardshipBaselineSchema>;
const initializationSchema = z.object({
  adoptionId: id, at: instant,
  census: z.object({ complete: z.literal(true), issues: z.array(stewardshipBaselineSchema) }).strict(),
}).strict();
export type StewardshipInitialization = z.infer<typeof initializationSchema>;

const diagnosticSchema = z.object({
  seat: seatFamily.nullable(),
  stage: z.enum(["evidence", "comparison", "input", "credential", "startup", "transport", "runtime", "response_json", "response_safety", "schema", "binding", "citations", "clauses", "archive", "reservation", "expansion"]),
  code: z.enum(["local_path", "refused", "invalid_json", "runtime_not_tool_free", "tool_event", "schema_invalid", "binding_mismatch", "absent_evidence", "unknown_fact", "incomplete_clauses", "unknown_clause", "invalid_code_quote", "archive_hash_mismatch", "assessment_timeout", "assessment_output_limit", "assessment_cleanup_failed", "assessment_spawn_failed", "assessment_input_failed", "assessment_exit_failed", "assessment_deadline", "seat_unavailable", "seat_startup_timeout"]),
  field: z.string().max(256).regex(/^\$(?:\.[A-Za-z][A-Za-z0-9]*|\[\d{1,3}\])*$/),
  method: z.string().refine(isStewardshipDiagnosticMethod).optional(),
}).strict();
const assessmentAttemptSchema = z.object({
  packetSha256: hash, assessmentSha256s: z.array(hash).max(2), diagnostics: z.array(diagnosticSchema).max(8),
}).strict();

export const stewardshipEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("initialized"), initialization: initializationSchema, policySha256: hash }).strict(),
  z.object({ type: z.literal("policy-changed"), previousPolicySha256: hash, policySha256: hash }).strict(),
  z.object({ type: z.literal("policy-upgraded"), previousPolicySha256: hash, policySha256: hash }).strict(),
  z.object({ type: z.literal("snapshot-approved"), snapshotSha256: hash, compileInputsSha256: hash,
    approvedBy: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/) }).strict(),
  z.object({ type: z.literal("snapshot-plan"), runId: id, snapshotSha256: hash, compileInputsSha256: hash,
    operations: z.array(z.object({ index: tokenCount, classification: z.enum(["send", "skip", "outage"]),
      reason: z.string().min(1).max(256).optional(), dependencyIndices: z.array(tokenCount) }).strict()),
    observationSha256s: z.array(hash), thresholdNumerator: tokenCount, thresholdDenominator: tokenCount }).strict(),
  z.object({ type: z.literal("snapshot-issue-skip"), runId: id, snapshotSha256: hash, compileInputsSha256: hash,
    issueNumber, phase: z.enum(["classification", "send"]), skippedIndices: z.array(tokenCount),
    confirmedActionIds: z.array(id), unresolvedActionIds: z.array(id), reason: z.string().min(1).max(256),
    causalIndices: z.array(tokenCount), directIndices: z.array(tokenCount) }).strict(),
  z.object({ type: z.literal("live-snapshot-compiled"), runId: id, snapshotSha256: hash, compileInputsSha256: hash }).strict(),
  z.object({ type: z.literal("backlog-compiled"), snapshotSha256: hash, compileInputsSha256: hash,
    liveRunId: id.optional(),
    compiledAt: instant.optional(), lifecycleTargets: z.array(z.object({ issueNumber, lifecycleTarget: lifecycleTargetSchema }).strict()).optional(),
    approvalEligible: z.boolean().optional() }).strict(),
  z.object({ type: z.literal("shadow-pass-started"), passId: id, censusSha256: hash, afterSnapshotSha256: hash.nullable() }).strict(),
  z.object({ type: z.literal("shadow-census-observed"), censusSha256: hash }).strict(),
  z.object({ type: z.literal("snapshot-intervention"), snapshotSha256: hash, actionId: id, issueNumber, field,
    overwrittenValue: fieldValue, nativeEventId }).strict(),
  z.object({ type: z.literal("snapshot-refused"), snapshotSha256: hash, reason: z.string().min(1).max(256),
    remaining: z.array(z.object({ issueNumber, operation: stewardshipOperationSchema }).strict()) }).strict(),
  z.object({ type: z.literal("snapshot-completed"), snapshotSha256: hash }).strict(),
  z.object({ type: z.literal("issue-baselined"), baseline: stewardshipBaselineSchema }).strict(),
  z.object({ type: z.literal("run-started"), runId: id, mode: z.enum(["run", "preview", "shadow"]).optional() }).strict(),
  z.object({ type: z.literal("issue-attempted"), runId: id, issueNumber, reason: z.string().min(1).max(256), nextEligibleAt: instant, assessmentAttempt: assessmentAttemptSchema.optional() }).strict(),
  z.object({ type: z.literal("issue-settled"), runId: id, issueNumber, materialEvidenceSha256: hash, executionSha256: hash, ...compilerProvenance }).strict(),
  z.object({ type: z.literal("report-delivery"), reportSha256: hash, outcome: z.enum(["delivered", "failed"]) }).strict(),
  z.object({ type: z.literal("assessment-started"), runId: id, attempt: z.number().int().min(1).max(2).optional() }).strict(),
  z.object({ type: z.literal("assessment-rejected"),
    ...diagnosticSchema.shape, seat: seatFamily, contentSha256: hash }).strict(),
  z.object({ type: z.literal("expansion-reserved"), runId: id, issueNumber }).strict(),
  z.object({ type: z.literal("evidence-recorded"), issueNumber, materialEvidenceSha256: hash, packetSha256: hash,
    originMainSha: z.string().regex(/^[a-f0-9]{40,64}$/), policySha256: hash.optional() }).strict(),
  z.object({ type: z.literal("issue-assessed"), runId: id, issueNumber, materialEvidenceSha256: hash, decisionSha256: hash, result: z.enum(["no-change", "eligible", "escalated"]), usage: issueUsageSchema.optional(), ...compilerProvenance }).strict(),
  z.object({ type: z.literal("assessment-divergence-recorded"), runId: id, issueNumber, materialEvidenceSha256: hash,
    assessmentSha256s: z.tuple([hash, hash]), differingKeys: z.array(z.enum(STEWARDSHIP_DIVERGENCE_KEYS)), clauseIds: z.array(id) }).strict(),
  z.object({ type: z.literal("field-observed"), issueNumber, field, value: fieldValue, frontier: stewardshipFrontierSchema, materialEvidenceSha256: hash,
    actor: z.enum(["operator", "bot", "unknown", "self"]), actionId: id.optional() }).strict(),
  // U2 proves attribution over the entire gap against archived, complete native history.
  z.object({ type: z.literal("field-history-recovered"), issueNumber, field, value: fieldValue, frontier: stewardshipFrontierSchema,
    materialEvidenceSha256: hash, historySha256: hash, attribution: z.enum(["operator", "bot", "self", "none", "unknown"]), actionId: id.optional() }).strict(),
  z.object({ type: z.literal("field-pinned"), issueNumber, field }).strict(),
  z.object({ type: z.literal("field-released"), issueNumber, field, value: fieldValue, frontier: stewardshipFrontierSchema }).strict(),
  // Evidence/citation eligibility is recompiled by U3 before requesting this event.
  z.object({ type: z.literal("hold-superseded"), issueNumber, field, previousEvidenceSha256: hash, materialEvidenceSha256: hash,
    changedFactIds: z.array(id).min(1), assessmentSha256s: z.tuple([hash, hash]) }).strict(),
  z.object({ type: z.literal("action-attempted"), runId: id, actionId: id, issueNumber, policySha256: hash, bindingSha256: hash, operation: stewardshipOperationSchema,
    snapshotSha256: hash.optional(), ...compilerProvenance }).strict(),
  z.object({ type: z.literal("action-outcome"), actionId: id, outcome: z.enum(["confirmed", "not-applied", "unresolved", "conflict"]), receiptSha256: hash,
    nativeEventIds: z.array(nativeEventId).optional() }).strict(),
  z.object({ type: z.literal("run-finished"), runId: id, resultSha256: hash }).strict(),
]);
export type StewardshipEvent = z.infer<typeof stewardshipEventSchema>;

export interface StewardshipHold {
  kind: "operator" | "pin" | "provenance";
  value: StewardshipFieldValue;
  frontier: StewardshipFrontier;
  materialEvidenceSha256: string;
  at: string;
}
export interface StewardshipFieldState {
  value: StewardshipFieldValue;
  frontier: StewardshipFrontier;
  lastCompleteFrontier: StewardshipFrontier | null;
  materialEvidenceSha256: string;
  hold: StewardshipHold | null;
  provenanceBase: { value: StewardshipFieldValue; frontier: StewardshipFrontier; operatorHold: StewardshipHold | null } | null;
  releasedAt: string | null;
}
export interface StewardshipIssueState {
  baseline: StewardshipBaseline;
  fields: Record<StewardshipField, StewardshipFieldState> & { Effort?: StewardshipFieldState; Lifecycle?: StewardshipFieldState; "Sort key"?: StewardshipFieldState };
  assessment: ({ at: string; materialEvidenceSha256: string; decisionSha256: string; result: "no-change" | "eligible" | "escalated"; usage?: StewardshipIssueUsage } & CompilerProvenance) | null;
  assessmentHistory?: NonNullable<StewardshipIssueState["assessment"]>[];
  evidencePackets?: Record<string, { packetSha256: string; originMainSha: string; policySha256: string }>;
  attempt?: { at: string; reason: string; nextEligibleAt: string; assessmentAttempt?: z.infer<typeof assessmentAttemptSchema> };
  consecutiveScoutFailures?: number;
  settlement?: { at: string; materialEvidenceSha256: string; executionSha256: string } & CompilerProvenance;
}
export interface StewardshipRunState {
  mode?: "run" | "preview" | "shadow";
  startedAt: string; assessmentCalls: number; remoteMutations: number;
  mutatedIssues: number[]; lastMutationAt: string | null; resultSha256: string | null;
  expandedIssueNumbers?: number[];
}
export interface StewardshipActionState extends CompilerProvenance {
  runId: string; issueNumber: number; operation: StewardshipOperation; bindingSha256: string; attemptedAt: string;
  policySha256?: string;
  snapshotSha256?: string;
  outcome: "confirmed" | "not-applied" | "unresolved" | "conflict" | null; receiptSha256: string | null;
  nativeEventIds: string[];
}
export interface StewardshipState {
  adoptionId: string; repository: string; policySha256: string; initializedAt: string;
  paused: boolean; sequence: number; headSha256: string;
  issues: Record<number, StewardshipIssueState>;
  runs: Record<string, StewardshipRunState>;
  actions: Record<string, StewardshipActionState>;
  lifecycleReceipts?: Record<number, StewardshipLifecycleReceipt>;
  lifecycleObservations?: LifecycleObservation[];
  snapshotAdoptedAt?: string;
  shadowPass?: { passId: string; censusSha256: string; issueNumbers: number[]; closedIssueNumbers: number[]; afterSnapshotSha256: string | null };
  pendingSnapshot?: { snapshotSha256: string; compileInputsSha256: string; liveRunId?: string };
  snapshots?: Record<string, { compileInputsSha256: string; approvedAt: string; status: "approved" | "replacement-required" | "completed";
    liveRunId?: string;
    operations: { issueNumber: number; operation: StewardshipOperation }[];
    plans?: Record<string, Extract<StewardshipEvent, { type: "snapshot-plan" }>>;
    skips?: Record<number, { reason: string; phase: "classification" | "send"; runId: string; direct: boolean }>;
    directSkipIndices?: number[];
    refusal?: { reason: string; remaining: { issueNumber: number; operation: StewardshipOperation }[] } }>;
  interventions?: { snapshotSha256: string; actionId: string; issueNumber: number; field: StewardshipNativeField; overwrittenValue: StewardshipFieldValue; nativeEventId: string; at: string }[];
  deliveries?: Record<string, { at: string; outcome: "delivered" | "failed" }>;
}
/** Only reuse-capable run compiles carry the one-time approval hold. */
export function isReuseCapableCompileInput(readArtifact: (hash: string) => unknown, compileInputsSha256: string): boolean {
  const input = readArtifact(compileInputsSha256) as Parameters<typeof compileStewardshipBacklog>[0];
  return input.observationReuse !== undefined;
}
export function stewardshipHeldSnapshot(state: StewardshipState, readArtifact: (hash: string) => unknown) {
  const pending = state.pendingSnapshot;
  if (pending?.liveRunId === undefined) return undefined;
  return isReuseCapableCompileInput(readArtifact, pending.compileInputsSha256) ? pending : undefined;
}
/** A replacement approval explicitly supersedes resolved uncertainty for its issue.
 * Unresolved legacy actions and interrupted sends with no outcome remain quarantined.
 */
export function stewardshipActionBlocksIssue(state: StewardshipState, action: StewardshipActionState, approvedSnapshotSha256?: string): boolean {
  if (action.outcome !== null && action.outcome !== "unresolved" && action.outcome !== "conflict") return false;
  if (action.outcome !== null && action.snapshotSha256 && state.snapshots?.[action.snapshotSha256]?.status === "replacement-required"
    && approvedSnapshotSha256 && approvedSnapshotSha256 !== action.snapshotSha256) {
    const replacement = state.snapshots[approvedSnapshotSha256];
    if (replacement?.status === "approved" && Date.parse(replacement.approvedAt) >= Date.parse(action.attemptedAt)
      && replacement.operations.some((entry) => entry.issueNumber === action.issueNumber)) return false;
  }
  return true;
}
export interface StewardshipLocation {
  /** Invocation-local immutable artifacts only; never shared across independent commands. */
  artifactCache?: StewardshipArtifactCache;
  root?: string; repository: string; policy: StewardshipPolicy; allowPolicyMismatch?: boolean;
  /** In-process test seam only; never read from policy, CLI arguments or environment. */
  hostLockPort?: number;
}

export function stewardshipPaths(input: { root?: string; repository: string }) {
  if (!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(input.repository)) throw new Error("Repository must be OWNER/REPO");
  const directory = join(resolve(input.root ?? defaultHostRoadmapControlRoot()), "stewardship", canonicalJsonSha256(input.repository.toLowerCase()));
  return { directory, journal: join(directory, "journal.jsonl"), control: join(directory, "control.json"), artifacts: join(directory, "artifacts"),
    rejectedAnswers: join(directory, "rejected-answers") };
}

// Content-bearing files consume this budget; hash/length-only entries remain available after exhaustion.
const REJECTED_ANSWER_RUN_BYTES = 1024 * 1024;
const REJECTED_ANSWER_RETENTION_MS = 30 * 86_400_000;
function secureRejectedDirectory(directory: string): void {
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid rejected-answer directory");
  if (process.platform !== "win32") { chmodSync(directory, 0o700); return; }
  // Same private-directory DACL the shadow artifacts use; failure refuses the archive write.
  try { createWindowsPrivateDirectoryAclController(process.env).secure(toNamespacedPath(directory)); }
  catch { throw new Error("Rejected-answer owner-only permissions unavailable"); }
}
function rejectedFiles(directory: string) {
  return readdirSync(directory).filter((name) => /^[a-f0-9]{64}-(?:[a-f0-9]{64}\.json|[a-f0-9-]{36}\.tmp)$/.test(name)).map((name) => {
    const path = join(directory, name); const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Invalid rejected-answer entry");
    return { name, path, stat };
  });
}
function purgeRejectedAnswers(directory: string, at: string): void {
  if (!existsSync(directory)) return;
  secureRejectedDirectory(directory);
  for (const entry of rejectedFiles(directory)) {
    if (entry.stat.mtimeMs < Date.parse(at) - REJECTED_ANSWER_RETENTION_MS) unlinkSync(entry.path);
    else if (process.platform !== "win32") chmodSync(entry.path, 0o600);
  }
}

const recordSchema = z.object({
  schemaVersion: z.literal("github-issue-roadmap-stewardship-journal/v1"),
  sequence: z.number().int().positive().safe(), previousSha256: hash.nullable(), at: instant,
  event: stewardshipEventSchema, sha256: hash,
}).strict();
const controlSchema = z.object({
  schemaVersion: z.literal("github-issue-roadmap-stewardship-control/v1"), repository: z.string(), adoptionId: id,
  policySha256: hash, paused: z.boolean(), at: instant, nonce: z.string().uuid(), sha256: hash,
}).strict();

function durableWrite(path: string, text: string, mode: "wx" | "a") {
  const file = openSync(path, mode, 0o600);
  try {
    const bytes = Buffer.from(text); let offset = 0;
    while (offset < bytes.length) { const written = writeSync(file, bytes, offset, bytes.length - offset); if (written < 1) throw new Error("Durable write made no progress"); offset += written; }
    fsyncSync(file);
  } finally { closeSync(file); }
}

function validateLocation(input: StewardshipLocation) {
  if (input.hostLockPort !== undefined && (!Number.isInteger(input.hostLockPort) || input.hostLockPort < 1 || input.hostLockPort > 65535)) {
    throw new Error("Host lock port must be an integer between 1 and 65535.");
  }
  const policy = parseStewardshipPolicy(input.policy);
  if (policy.repository !== input.repository.toLowerCase()) throw new Error("Policy repository binding mismatch");
  return { policy, paths: stewardshipPaths(input) };
}
function validateValue(name: z.infer<typeof field>, value: StewardshipFieldValue) {
  (name === "Priority" ? stewardshipPrioritySchema : name === "Effort" ? effortValue : name === "Lifecycle" ? stewardshipLifecycleSchema : name === "Sort key" ? stewardshipSortKeySchema : stewardshipHorizonSchema).nullable().parse(value);
}
/** The assessed packet, rather than an earlier operation's readback, identifies the evidence. */
export function createStewardshipLifecycleReceipt(input: { issueNumber: number; snapshotSha256: string;
  compile: Parameters<typeof compileStewardshipBacklog>[0]; readArtifact: (hash: string) => unknown;
  after: StewardshipObservation; nativeEventId: string; confirmedAt: string }): StewardshipLifecycleReceipt {
  const assessedHash = input.compile.projection.issues[input.issueNumber].assessment?.packetSha256;
  const packet = assessedHash ? input.readArtifact(assessedHash) as StewardshipIssueEvidencePacket
    : input.compile.observations?.[input.issueNumber]?.evidence.packet;
  const event = input.after.evidence.packet.fieldHistory.Lifecycle?.events.find((event) => event.id === input.nativeEventId);
  if (!packet || packet.issueNumber !== input.issueNumber || !event || event.actorLogin !== input.compile.policy.operator
    || event.field !== "Lifecycle") throw new Error("Lifecycle receipt missing authenticated evidence or field event");
  return lifecycleReceiptSchema.parse({ issueNumber: input.issueNumber, value: input.after.evidence.packet.fields.Lifecycle,
    snapshotSha256: input.snapshotSha256, assessedUpdatedAt: packet.issue.v1.updatedAt,
    evidenceIdentity: { packetSha256: assessedHash ?? canonicalJsonSha256(packet), materialEvidenceSha256: packet.materialEvidenceSha256 },
    fieldEvent: { id: event.id, actor: event.actorLogin, createdAt: event.createdAt }, confirmedAt: input.confirmedAt });
}
function lifecycleCompileTargets(snapshot: ReturnType<typeof compileStewardshipBacklog>): Pick<LifecycleObservation, "issueNumber" | "lifecycleTarget">[] {
  return snapshot.issues.map((issue) => {
    if (issue.coverageOutcome) return { issueNumber: issue.issueNumber, lifecycleTarget: "hold" };
    const target = issue.targets.find((target) => target.field === "Lifecycle")!;
    // A hold is explicit, even if a flag remains live. It is not affirmative closure evidence.
    const lifecycleTarget: LifecycleObservation["lifecycleTarget"] = target.reason === "lifecycle_agreed_flag" ? stewardshipLifecycleSchema.parse(target.value)
      : target.disposition === "executable" && target.value === null ? "empty"
      : target.reason.endsWith("lifecycle_history_incomplete") ? "hold"
      : target.current === null && target.value === null ? "empty" : "hold";
    return { issueNumber: issue.issueNumber, lifecycleTarget };
  });
}
function recordLifecycleCompile(state: StewardshipState, snapshot: ReturnType<typeof compileStewardshipBacklog>, at: string) {
  const observations = state.lifecycleObservations ??= [];
  if (observations.some((entry) => entry.compileSnapshotSha256 === snapshot.snapshotSha256)) return;
  const input = snapshot.inputs as Parameters<typeof compileStewardshipBacklog>[0];
  observations.push(...lifecycleCompileTargets(snapshot).filter((target) => {
    const observation = input.observations?.[target.issueNumber];
    return observation?.census.complete === true;
  }).map((target) => ({ ...target, compileSnapshotSha256: snapshot.snapshotSha256, compiledAt: at })));
}
function addBaseline(state: StewardshipState, baseline: StewardshipBaseline, writesSortKey: boolean) {
  if (Object.hasOwn(state.issues, baseline.issueNumber)) throw new Error("Duplicate issue baseline");
  const make = (name: "Priority" | "Horizon"): StewardshipFieldState => ({ value: baseline.fields[name], frontier: baseline.frontiers[name],
    lastCompleteFrontier: baseline.frontiers[name].complete ? baseline.frontiers[name] : null,
    materialEvidenceSha256: baseline.materialEvidenceSha256,
    hold: baseline.frontiers[name].complete ? null : { kind: "provenance", value: baseline.fields[name], frontier: baseline.frontiers[name], materialEvidenceSha256: baseline.materialEvidenceSha256, at: state.initializedAt },
    provenanceBase: baseline.frontiers[name].complete ? null : { value: baseline.fields[name], frontier: baseline.frontiers[name], operatorHold: null }, releasedAt: null });
  state.issues[baseline.issueNumber] = { baseline, fields: { Priority: make("Priority"), Horizon: make("Horizon") }, assessment: null };
  if (baseline.fields.Effort !== undefined || state.snapshotAdoptedAt) observedField(state.issues[baseline.issueNumber], "Effort", state.initializedAt);
  if (baseline.fields.Lifecycle !== undefined || state.snapshotAdoptedAt) observedField(state.issues[baseline.issueNumber], "Lifecycle", state.initializedAt);
  if (writesSortKey) observedField(state.issues[baseline.issueNumber], "Sort key", state.initializedAt);
}
/** The sorter owns Sort key: an observation records value and frontier but never creates a hold (plan KTD7). */
function observeSortKey(current: StewardshipFieldState, event: { value: StewardshipFieldValue; frontier: StewardshipFrontier; materialEvidenceSha256: string }) {
  current.value = event.value; current.frontier = event.frontier; current.materialEvidenceSha256 = event.materialEvidenceSha256;
  if (event.frontier.complete) current.lastCompleteFrontier = event.frontier;
  current.hold = null; current.provenanceBase = null;
}
function getIssue(state: StewardshipState, number: number) {
  const issue = state.issues[number]; if (!issue) throw new Error("Issue has no adoption baseline"); return issue;
}
function observedField(issue: StewardshipIssueState, name: z.infer<typeof field>, at: string): StewardshipFieldState {
  const existing = issue.fields[name]; if (existing) return existing;
  const frontier = issue.baseline.frontiers[name] ?? { complete: true, eventIds: [], cursor: null };
  const value = issue.baseline.fields[name] ?? null;
  return issue.fields[name] = { value, frontier,
    lastCompleteFrontier: frontier.complete ? frontier : null, materialEvidenceSha256: issue.baseline.materialEvidenceSha256,
    hold: name === "Sort key" || frontier.complete ? null : { kind: "provenance", value, frontier, materialEvidenceSha256: issue.baseline.materialEvidenceSha256, at },
    provenanceBase: name === "Sort key" || frontier.complete ? null : { value, frontier, operatorHold: null }, releasedAt: null };
}
export class StewardshipReservationRefusal extends Error {
  constructor(readonly code: "paused" | "run_deadline" | "call_budget", message: string) { super(message); }
}
function getRun(state: StewardshipState, runId: string, at: string, policy: StewardshipPolicy, admission = false) {
  const run = state.runs[runId]; if (!run || run.resultSha256 !== null) throw new Error("Run missing or already finished");
  const elapsed = Date.parse(at) - Date.parse(run.startedAt);
  if (elapsed < 0 || elapsed >= (admission ? policy.limits.assessmentAdmissionMs : policy.limits.runDurationMs)) throw new StewardshipReservationRefusal("run_deadline", "Run deadline exceeded");
  return run;
}
function ownOperationField(operation: StewardshipOperation): StewardshipNativeField | null {
  return stewardshipOperationField(operation);
}
function ownOperationValue(operation: StewardshipOperation): StewardshipFieldValue {
  return stewardshipOperationValue(operation);
}

/** Replay is the only state derivation. All transition constraints run again on disk reads. */
function rejectRehearsalArtifact(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const payload = value as { schemaVersion?: unknown; rehearsal?: unknown };
  if (payload.rehearsal === true || payload.schemaVersion === "github-issue-roadmap-rehearsal/v1") throw new Error("rehearsal_artifact_not_durable");
}
function reduce(state: StewardshipState, event: StewardshipEvent, at: string, policy: StewardshipPolicy, readArtifact: (hash: string) => unknown,
  journal: readonly { event: StewardshipEvent; at: string }[] = []) {
  rejectRehearsalArtifact(event);
  if (event.type === "initialized") throw new Error("Duplicate adoption initialization");
  switch (event.type) {
    case "shadow-pass-started":
    case "shadow-census-observed": {
      if (!isSnapshotStewardshipPolicy(policy)) throw new Error("Shadow requires policy-upgrade");
      const raw = readArtifact(event.censusSha256);
      const census = z.object({ complete: z.literal(true), totalCount: z.number().int().nonnegative(), issueNumbers: z.array(issueNumber),
        members: z.array(z.object({ issueNumber, state: z.string() }).passthrough()).optional() }).passthrough().parse(raw);
      if (canonicalJsonSha256(raw) !== event.censusSha256 || census.totalCount !== census.issueNumbers.length
        || new Set(census.issueNumbers).size !== census.issueNumbers.length) throw new Error("Invalid shadow census");
      if (event.type === "shadow-pass-started") {
        if (Object.values(state.snapshots ?? {}).some((snapshot) => snapshot.status === "approved")) throw new Error("Approved snapshot still active");
        state.shadowPass = { passId: event.passId, censusSha256: event.censusSha256, issueNumbers: [...census.issueNumbers], closedIssueNumbers: [], afterSnapshotSha256: event.afterSnapshotSha256 };
        delete state.pendingSnapshot;
      }
      const pass = state.shadowPass;
      if (!pass) throw new Error("Shadow census not frozen");
      pass.closedIssueNumbers = pass.issueNumbers.filter((number) => !census.issueNumbers.includes(number));
      delete state.pendingSnapshot;
      break;
    }
    case "policy-upgraded":
    case "policy-changed": {
      const approved = Object.entries(state.snapshots ?? {}).find(([, snapshot]) => snapshot.status === "approved");
      if (approved) throw new Error(`Policy update refused: approved snapshot ${approved[0]} still active`);
      if (event.previousPolicySha256 !== state.policySha256 || event.policySha256 === state.policySha256) throw new Error("Policy change epoch binding mismatch");
      if (Object.values(state.runs).some((run) => run.resultSha256 === null)) throw new Error("Policy update refused: unfinished run");
      const nextPolicy = resolveStewardshipPolicy(event.policySha256, policy);
      (event.type === "policy-upgraded" ? validateStewardshipPolicyUpgrade : validateStewardshipPolicyChange)(policy, nextPolicy);
      state.policySha256 = event.policySha256;
      if (event.type === "policy-upgraded") {
        const retainsAssessments = stewardshipPolicyUpgradePreservesAssessments(policy, nextPolicy);
        if (!retainsAssessments) state.snapshotAdoptedAt = at;
        const writable = stewardshipWritableFields(nextPolicy);
        for (const issue of Object.values(state.issues)) {
          for (const field of writable) observedField(issue, field, at);
          if (!retainsAssessments) { issue.assessment = null; delete issue.assessmentHistory; delete issue.settlement; delete issue.attempt; }
        }
      }
      break;
    }
    case "backlog-compiled": {
      if (!isSnapshotStewardshipPolicy(policy)) throw new Error("Compile observations require policy-upgrade");
      const input = readArtifact(event.compileInputsSha256) as Parameters<typeof compileStewardshipBacklog>[0];
      const snapshot = compileStewardshipBacklog(input);
      if (event.liveRunId !== undefined) {
        const completedSha = Object.entries(state.snapshots ?? {}).filter(([, entry]) => entry.status === "completed").at(-1)?.[0];
        if ((state.pendingSnapshot && state.pendingSnapshot.liveRunId === undefined)
          || (completedSha && state.shadowPass?.afterSnapshotSha256 === completedSha)) {
          throw new Error(`shadow_pending_approval: ${state.pendingSnapshot?.snapshotSha256 ?? state.shadowPass!.passId}`);
        }
        if (!Object.values(state.snapshots ?? {}).some((entry) => entry.status === "completed")
          || !input.hasLiveSnapshot || !input.firstApprovedCycleCompleted) throw new Error("Live compile requires approved snapshot completion");
        if (input.coveredOnly !== true) throw new Error("Live compile requires covered-only targets");
        if ((getRun(state, event.liveRunId, at, policy).mode ?? "run") !== "run") throw new Error("Live compile requires a live run");
      }
      if (canonicalJsonSha256(input) !== event.compileInputsSha256 || snapshot.snapshotSha256 !== event.snapshotSha256
        || stewardshipPolicySha256(input.policy) !== state.policySha256
        || (event.compiledAt !== undefined && event.compiledAt !== at)
        || (event.lifecycleTargets !== undefined && canonicalJsonSha256(event.lifecycleTargets) !== canonicalJsonSha256(lifecycleCompileTargets(snapshot)))) throw new Error("Invalid compile observation binding");
      // A replay of an already verified compile keeps its original observation even
      // when later pins or receipts have changed the live projection's gates.
      if (!state.lifecycleObservations?.some((entry) => entry.compileSnapshotSha256 === event.snapshotSha256)
        && state.snapshots?.[event.snapshotSha256]?.compileInputsSha256 !== event.compileInputsSha256) {
        validateStewardshipProjectionGates({ projection: input.projection, observations: input.observations,
          state: event.liveRunId === undefined ? state : { ...state, shadowPass: undefined }, journal, readArtifact, operator: policy.operator });
      }
      if (snapshot.status === "ready" && event.approvalEligible !== false && !state.snapshots?.[event.snapshotSha256]) {
        state.pendingSnapshot = { snapshotSha256: event.snapshotSha256, compileInputsSha256: event.compileInputsSha256,
          ...(event.liveRunId === undefined ? {} : { liveRunId: event.liveRunId }) };
      }
      else delete state.pendingSnapshot;
      if (snapshot.status === "ready" && event.approvalEligible !== false) recordLifecycleCompile(state, snapshot, at);
      break;
    }
    case "live-snapshot-compiled":
    case "snapshot-approved": {
      if (!isSnapshotStewardshipPolicy(policy)) throw new Error("Snapshot authority requires policy-upgrade");
      const live = event.type === "live-snapshot-compiled";
      const held = !live ? stewardshipHeldSnapshot(state, readArtifact) : undefined;
      if (live) {
        if (!Object.values(state.snapshots ?? {}).some((entry) => entry.status === "completed")) throw new Error("Live compile requires approved snapshot completion");
        const run = getRun(state, event.runId, at, policy);
        if ((run.mode ?? "run") !== "run") throw new Error("Live compile requires a live run");
      } else if (event.approvedBy !== policy.operator) throw new Error("Snapshot approver must be the policy operator");
      if ((live || held || state.shadowPass) && (state.pendingSnapshot?.snapshotSha256 !== event.snapshotSha256
        || state.pendingSnapshot.compileInputsSha256 !== event.compileInputsSha256)) throw new Error("Unknown or superseded snapshot");
      if (live && state.pendingSnapshot?.liveRunId !== event.runId) throw new Error("Live compile run binding mismatch");
      const snapshots = state.snapshots ??= {};
      if (snapshots[event.snapshotSha256] || Object.values(snapshots).some((entry) => entry.status === "approved")) throw new Error("Snapshot already approved or still active");
      const input = readArtifact(event.compileInputsSha256) as Parameters<typeof compileStewardshipBacklog>[0];
      const completed = Object.values(snapshots).some((entry) => entry.status === "completed");
      if (input.hasLiveSnapshot !== completed) throw new Error("Snapshot live-snapshot gate mismatch");
      if (input.firstApprovedCycleCompleted !== completed) throw new Error("Snapshot first-cycle completion mismatch");
      validateStewardshipProjectionGates({ projection: input.projection, observations: input.observations,
        state: live || held ? { ...state, shadowPass: undefined } : state, journal, readArtifact, operator: policy.operator });
      const snapshot = compileStewardshipBacklog(input);
      if (canonicalJsonSha256(input) !== event.compileInputsSha256 || snapshot.snapshotSha256 !== event.snapshotSha256 || snapshot.status !== "ready"
        || stewardshipPolicySha256(input.policy) !== state.policySha256) throw new Error("Invalid approved snapshot binding");
      const operations = stewardshipSnapshotOperations(snapshot);
      if (new Set(operations.map((entry) => canonicalJsonSha256([entry.issueNumber, entry.operation]))).size !== operations.length) throw new Error("Duplicate snapshot operation identity");
      for (const entry of operations) {
        const observation = input.observations?.[entry.issueNumber];
        const issue = input.projection.issues[entry.issueNumber];
        if (observation && observation.census.complete !== true) throw new Error("Incomplete snapshot observation");
        if (!observation || observation.evidence.packet.issueNumber !== entry.issueNumber
          || observation.evidence.policySha256 !== state.policySha256 || observation.evidence.packet.issue.v1.state !== "OPEN"
          || STEWARDSHIP_NATIVE_FIELDS.some((field) => (observation.evidence.packet.fields[field] ?? null) !== issue.fields[field])) throw new Error("Snapshot missing bound observation");
      }
      // The executor uses the same active-authority state for the approved cycle
      // and its later live compiles; the event records which granted authority.
      snapshots[event.snapshotSha256] = { compileInputsSha256: event.compileInputsSha256, approvedAt: at, status: "approved", operations,
        ...(live ? { liveRunId: event.runId } : held ? { liveRunId: held.liveRunId } : {}) };
      delete state.pendingSnapshot;
      break;
    }
    case "snapshot-plan":
    case "snapshot-issue-skip": {
      const snapshot = state.snapshots?.[event.snapshotSha256];
      if (!snapshot || snapshot.status !== "approved") throw new Error("Snapshot not active");
      if (snapshot.compileInputsSha256 !== event.compileInputsSha256) throw new Error("Snapshot compile binding mismatch");
      getRun(state, event.runId, at, policy);
      const indices = event.type === "snapshot-plan"
        ? event.operations.flatMap((operation) => [operation.index, ...operation.dependencyIndices])
        : [...event.skippedIndices, ...event.directIndices, ...event.causalIndices];
      if (indices.some((index) => !snapshot.operations[index])) throw new Error("Invalid snapshot operation index");
      if (event.type === "snapshot-plan") {
        if (new Set(event.operations.map((operation) => operation.index)).size !== event.operations.length) throw new Error("Duplicate snapshot plan index");
        if (snapshot.plans?.[event.runId]) throw new Error("Snapshot plan already recorded for run");
        const directIndices = new Set([...(snapshot.directSkipIndices ?? []),
          ...event.operations.filter((operation) => operation.classification === "skip").map((operation) => operation.index)]);
        if (event.thresholdDenominator !== snapshot.operations.length || event.thresholdNumerator !== directIndices.size) throw new Error("Snapshot plan threshold mismatch");
        (snapshot.plans ??= {})[event.runId] = event;
      } else {
        // Send-phase own-issue seeds trust executor-observed fence drift, which the journal
        // does not carry, as with stale-snapshot refusals. causalIndices is informational;
        // skip provenance is computed from the plan, not from that field.
        if (event.skippedIndices.length === 0) throw new Error("Empty snapshot skip");
        for (const indices of [event.skippedIndices, event.directIndices, event.causalIndices]) {
          if (new Set(indices).size !== indices.length) throw new Error("Duplicate snapshot skip index");
        }
        const plan = snapshot.plans?.[event.runId];
        if (!plan) throw new Error("Snapshot skip requires a plan for this run");
        if (!event.skippedIndices.some((index) => snapshot.operations[index].issueNumber === event.issueNumber)) throw new Error("Skip issue must own a skipped operation");
        if (event.directIndices.some((index) => !event.skippedIndices.includes(index) || snapshot.operations[index].issueNumber !== event.issueNumber)
          || (event.phase === "send" && event.directIndices.length > 0)) throw new Error("Invalid direct skip indices");
        if (event.phase === "classification") {
          const plannedDirect = plan.operations.filter((operation) => operation.classification === "skip"
            && snapshot.operations[operation.index].issueNumber === event.issueNumber).map((operation) => operation.index);
          if (plannedDirect.length !== event.directIndices.length || plannedDirect.some((index) => !event.directIndices.includes(index))) throw new Error("Direct skips do not match plan");
        }
        const actions = Object.values(state.actions).filter((action) => action.snapshotSha256 === event.snapshotSha256);
        const hasAction = (index: number) => actions.some((action) => action.issueNumber === snapshot.operations[index].issueNumber
          && canonicalJsonSha256(action.operation) === canonicalJsonSha256(snapshot.operations[index].operation));
        for (const index of event.skippedIndices) {
          if (hasAction(index)) throw new Error("Cannot skip an attempted snapshot operation");
        }
        if (snapshot.operations.some((target, index) => target.issueNumber === event.issueNumber && !hasAction(index)
          && !event.skippedIndices.includes(index))) throw new Error("Skip must cover every un-actioned operation of the issue");
        const skippedIssues = new Set(event.skippedIndices.map((index) => snapshot.operations[index].issueNumber));
        for (const [ids, outcomes] of [[event.confirmedActionIds, ["confirmed"]], [event.unresolvedActionIds, ["unresolved", "conflict", null]]] as const) {
          for (const actionId of ids) {
            const action = state.actions[actionId];
            if (!action || action.snapshotSha256 !== event.snapshotSha256 || !skippedIssues.has(action.issueNumber)
              || !(outcomes as readonly (string | null)[]).includes(action.outcome)
              || !snapshot.operations.some((target) => target.issueNumber === action.issueNumber
                && canonicalJsonSha256(target.operation) === canonicalJsonSha256(action.operation))) throw new Error("Invalid snapshot skip action reference");
          }
        }
        // Provenance is justified by a same-issue sibling of a direct skip, prior skip, or N op, or a plan dependency path from a skipped or N op.
        const priorIndices = Object.keys(snapshot.skips ?? {}).map(Number);
        const notAppliedIndices = snapshot.operations.flatMap((operation, index) => actions.some((action) => action.outcome === "not-applied"
          && action.issueNumber === operation.issueNumber && canonicalJsonSha256(action.operation) === canonicalJsonSha256(operation.operation)) ? [index] : []);
        const seeds = [...priorIndices, ...event.directIndices, ...notAppliedIndices];
        const siblingIssues = new Set(seeds.map((index) => snapshot.operations[index].issueNumber));
        const justified = new Set([...seeds,
          ...event.skippedIndices.filter((index) => event.phase === "send"
            ? snapshot.operations[index].issueNumber === event.issueNumber : siblingIssues.has(snapshot.operations[index].issueNumber))]);
        let changed = true;
        while (changed) {
          changed = false;
          const justifiedIssues = new Set([...justified].map((index) => snapshot.operations[index].issueNumber));
          for (const [index, operation] of snapshot.operations.entries()) {
            if (!justified.has(index) && justifiedIssues.has(operation.issueNumber)) {
              justified.add(index); changed = true;
            }
          }
          for (const operation of plan.operations) {
            if (!justified.has(operation.index) && operation.dependencyIndices.some((index) => justified.has(index))) {
              justified.add(operation.index); changed = true;
            }
          }
        }
        if (event.skippedIndices.some((index) => !justified.has(index))) throw new Error("Snapshot skip lacks plan provenance");
        // Validate the whole event first. Preserve each existing skip record exactly;
        // the carried direct-index union below is separate from first-skip provenance.
        const skips = snapshot.skips ??= {};
        for (const index of event.skippedIndices) {
          skips[index] ??= { reason: event.reason, phase: event.phase, runId: event.runId, direct: event.directIndices.includes(index) };
        }
        if (event.directIndices.length) snapshot.directSkipIndices = [...new Set([...(snapshot.directSkipIndices ?? []), ...event.directIndices])].sort((a, b) => a - b);
      }
      break;
    }
    case "snapshot-intervention": {
      const action = state.actions[event.actionId];
      if (!action || action.snapshotSha256 !== event.snapshotSha256 || action.issueNumber !== event.issueNumber
        || stewardshipOperationField(action.operation) !== event.field || action.outcome !== "conflict") throw new Error("Invalid snapshot intervention binding");
      (state.interventions ??= []).push({ ...event, at }); break;
    }
    case "snapshot-refused": {
      const snapshot = state.snapshots?.[event.snapshotSha256];
      if (!snapshot || snapshot.status !== "approved") throw new Error("Snapshot not active");
      if (event.reason === "completed-with-skips" && !snapshot.operations.every((target, index) => snapshot.skips?.[index]
        || Object.values(state.actions).some((action) => action.snapshotSha256 === event.snapshotSha256
          && (action.outcome === "confirmed" || action.outcome === "not-applied") && action.issueNumber === target.issueNumber
          && canonicalJsonSha256(action.operation) === canonicalJsonSha256(target.operation)))) throw new Error("Snapshot has pending or uncertain operations");
      snapshot.status = "replacement-required"; snapshot.refusal = { reason: event.reason, remaining: event.remaining }; break;
    }
    case "snapshot-completed": {
      const snapshot = state.snapshots?.[event.snapshotSha256];
      if (!snapshot || snapshot.status !== "approved") throw new Error("Snapshot not active");
      if (!snapshot.operations.every((operation) => Object.values(state.actions).some((action) => action.snapshotSha256 === event.snapshotSha256
        && action.outcome === "confirmed" && action.issueNumber === operation.issueNumber
        && canonicalJsonSha256(action.operation) === canonicalJsonSha256(operation.operation)))) throw new Error("Snapshot has unconfirmed executable operations");
      snapshot.status = "completed"; break;
    }
    case "issue-baselined": addBaseline(state, event.baseline, stewardshipWritableFields(policy).includes("Sort key")); break;
    case "issue-attempted": {
      getRun(state, event.runId, at, policy);
      if (Date.parse(event.nextEligibleAt) < Date.parse(at)) throw new Error("Attempt eligibility precedes attempt");
      const issue = getIssue(state, event.issueNumber);
      if (event.reason === "scout_failed") issue.consecutiveScoutFailures = (issue.consecutiveScoutFailures ?? 0) + 1;
      else if (["assessed", "unchanged_settlement", "evidence_changed"].includes(event.reason)) issue.consecutiveScoutFailures = 0;
      issue.attempt = { at, reason: event.reason, nextEligibleAt: event.nextEligibleAt,
        ...(event.assessmentAttempt ? { assessmentAttempt: event.assessmentAttempt } : {}) }; break;
    }
    case "issue-settled": {
      getRun(state, event.runId, at, policy);
      getIssue(state, event.issueNumber).settlement = { at, materialEvidenceSha256: event.materialEvidenceSha256, executionSha256: event.executionSha256,
        ...eventCompilerProvenance(event) }; break;
    }
    case "report-delivery": {
      if (!Object.values(state.runs).some((run) => run.resultSha256 === event.reportSha256)) throw new Error("Unknown terminal report");
      const deliveries = state.deliveries ??= {};
      if (deliveries[event.reportSha256]?.outcome !== "delivered") deliveries[event.reportSha256] = { at, outcome: event.outcome }; break;
    }
    case "run-started":
      if (Object.hasOwn(state.runs, event.runId)) throw new Error("Duplicate run ID");
      state.runs[event.runId] = { mode: event.mode ?? "run", startedAt: at, assessmentCalls: 0, remoteMutations: 0, mutatedIssues: [], lastMutationAt: null, resultSha256: null }; break;
    case "assessment-started": {
      // Historical v1 calls keep their original replay rules. v2 admission is per issue.
      const run = getRun(state, event.runId, at, policy, stewardshipTimeoutRetries(policy) === 0);
      if (run.assessmentCalls >= policy.limits.assessmentCalls) throw new StewardshipReservationRefusal("call_budget", "Assessment budget exhausted");
      run.assessmentCalls++; break;
    }
    // Diagnostic-only history: no authority, state transition, or required artifact reference.
    case "assessment-rejected": break;
    case "assessment-divergence-recorded": break;
    case "expansion-reserved": {
      const run = getRun(state, event.runId, at, policy, true);
      if (stewardshipTimeoutRetries(policy) > 0) {
        if (policy.limits.assessmentCalls - run.assessmentCalls < 2) throw new StewardshipReservationRefusal("call_budget", "call_budget_exhausted");
        const remaining = policy.limits.assessmentAdmissionMs - (Date.parse(at) - Date.parse(run.startedAt));
        if (remaining < 2 * policy.limits.assessmentTimeoutMs) throw new Error("Expansion admission closed");
      }
      const expanded = run.expandedIssueNumbers ??= [];
      if (expanded.length >= policy.limits.expandedIssues || expanded.includes(event.issueNumber)) throw new Error("Expansion budget exhausted or already reserved");
      expanded.push(event.issueNumber); break;
    }
    case "evidence-recorded": {
      const index = getIssue(state, event.issueNumber).evidencePackets ??= Object.create(null);
      // The first immutable packet for an identity remains the contemporaneous witness.
      index[event.materialEvidenceSha256] ??= { packetSha256: event.packetSha256, originMainSha: event.originMainSha, policySha256: event.policySha256 ?? state.policySha256 };
      break;
    }
    case "issue-assessed": {
      getRun(state, event.runId, at, policy);
      const issue = getIssue(state, event.issueNumber);
      if (issue.assessment) (issue.assessmentHistory ??= []).push(issue.assessment);
      if (issue.settlement && (issue.settlement.materialEvidenceSha256 !== event.materialEvidenceSha256
        || issue.settlement.compilerVersion !== event.compilerVersion
        || !sameStewardshipSeatFamilies(issue.settlement.seatFamilies, event.seatFamilies))) delete issue.settlement;
      issue.assessment = { at, materialEvidenceSha256: event.materialEvidenceSha256, decisionSha256: event.decisionSha256, result: event.result,
        ...eventCompilerProvenance(event), ...(event.usage === undefined ? {} : { usage: event.usage }) }; break;
    }
    case "field-observed": {
      validateValue(event.field, event.value);
      const current = observedField(getIssue(state, event.issueNumber), event.field, at);
      if (event.field === "Sort key") {
        observeSortKey(current, event); break;
      }
      const known = new Set(current.frontier.eventIds);
      const newEvents = event.frontier.eventIds.filter((value) => !known.has(value));
      const anchor = current.lastCompleteFrontier ?? current.frontier;
      const overlap = anchor.eventIds.length === 0 || event.frontier.eventIds.some((value) => anchor.eventIds.includes(value));
      const complete = event.frontier.complete && overlap;
      let authored = false;
      if (event.actor === "self" && event.actionId) {
        const action = state.actions[event.actionId];
        authored = action !== undefined && action.outcome === "confirmed" && action.issueNumber === event.issueNumber
          && ownOperationField(action.operation) === event.field && ownOperationValue(action.operation) === event.value
          && newEvents.length > 0 && newEvents.every((eventId) => action.nativeEventIds.includes(eventId));
      }
      const changed = event.value !== current.value || newEvents.length > 0;
      if (current.hold?.kind !== "pin" && (!complete || (changed && (event.actor === "unknown" || (event.actor === "self" && !authored))))) {
        current.provenanceBase ??= { value: current.value, frontier: anchor, operatorHold: current.hold?.kind === "operator" ? current.hold : null };
        current.hold = { kind: "provenance", value: event.value, frontier: event.frontier, materialEvidenceSha256: event.materialEvidenceSha256, at };
      } else if (current.hold?.kind !== "pin" && current.hold?.kind !== "provenance" && complete && changed && event.actor === "operator") {
        current.hold = { kind: "operator", value: event.value, frontier: event.frontier, materialEvidenceSha256: event.materialEvidenceSha256, at };
      }
      current.value = event.value; current.frontier = { ...event.frontier, complete }; current.materialEvidenceSha256 = event.materialEvidenceSha256;
      if (complete) current.lastCompleteFrontier = current.frontier;
      break;
    }
    case "field-history-recovered": {
      validateValue(event.field, event.value);
      const current = observedField(getIssue(state, event.issueNumber), event.field, at);
      if (event.field === "Sort key") {
        observeSortKey(current, event); break;
      }
      const anchor = current.provenanceBase?.frontier ?? current.lastCompleteFrontier ?? current.frontier;
      if (!event.frontier.complete || (anchor.eventIds.length > 0 && !event.frontier.eventIds.some((value) => anchor.eventIds.includes(value)))) throw new Error("Recovery requires complete history overlapping the last known frontier");
      const base = current.provenanceBase;
      if (current.hold?.kind === "provenance" && base) {
        const newEvents = event.frontier.eventIds.filter((value) => !base.frontier.eventIds.includes(value));
        if (event.attribution === "none" && (event.value !== base.value || newEvents.length !== 0
          || base.frontier.eventIds.some((value) => !event.frontier.eventIds.includes(value)))) throw new Error("Recovered non-intervention requires the exact known value and field history");
        let proven = event.attribution === "bot" || event.attribution === "none";
        if (event.attribution === "self" && event.actionId) {
          const action = state.actions[event.actionId];
          proven = action !== undefined && action.outcome === "confirmed" && action.issueNumber === event.issueNumber
            && ownOperationField(action.operation) === event.field && ownOperationValue(action.operation) === event.value
            && newEvents.length > 0 && newEvents.every((eventId) => action.nativeEventIds.includes(eventId));
        }
        if (event.attribution === "operator") {
          current.hold = { kind: "operator", value: event.value, frontier: event.frontier,
            materialEvidenceSha256: current.hold.materialEvidenceSha256, at: current.hold.at };
          current.provenanceBase = null;
        } else if (proven) { current.hold = base.operatorHold; current.provenanceBase = null; }
      }
      // Pins and existing operator holds survive recovery, even if a bot changed the native value.
      current.value = event.value; current.frontier = event.frontier; current.lastCompleteFrontier = event.frontier;
      current.materialEvidenceSha256 = event.materialEvidenceSha256;
      break;
    }
    case "field-pinned": {
      if (event.field === "Sort key") throw new Error("Sort key cannot be pinned or released");
      const current = observedField(getIssue(state, event.issueNumber), event.field, at);
      current.hold = { kind: "pin", value: current.value, frontier: current.frontier, materialEvidenceSha256: current.materialEvidenceSha256, at }; break;
    }
    case "field-released": {
      if (event.field === "Sort key") throw new Error("Sort key cannot be pinned or released");
      const issue = getIssue(state, event.issueNumber); const current = observedField(issue, event.field, at);
      if (!current.frontier.complete || !event.frontier.complete || event.value !== current.value || canonicalJsonSha256(event.frontier) !== canonicalJsonSha256(current.frontier)) throw new Error("Release requires exact current value and complete event frontier");
      current.hold = null; current.provenanceBase = null; current.releasedAt = at; issue.assessment = null; delete issue.settlement; delete issue.attempt; break;
    }
    case "hold-superseded": {
      if (isSnapshotStewardshipPolicy(policy) && (event.field === "Horizon" || event.field === "Effort")) throw new Error("Pinned fields require explicit release");
      const issue = getIssue(state, event.issueNumber); const current = observedField(issue, event.field, at); const hold = current.hold;
      if (!hold || hold.kind !== "operator" || !current.frontier.complete || event.previousEvidenceSha256 !== hold.materialEvidenceSha256
        || Date.parse(at) <= Date.parse(hold.at) || event.materialEvidenceSha256 === hold.materialEvidenceSha256
        || event.assessmentSha256s[0] === event.assessmentSha256s[1]) throw new Error("Hold supersession requires complete newer material evidence and distinct fresh assessments");
      current.hold = null; current.materialEvidenceSha256 = event.materialEvidenceSha256; issue.assessment = null; break;
    }
    case "action-attempted": {
      if (Object.hasOwn(state.actions, event.actionId)) throw new Error("Duplicate action ID");
      if (event.policySha256 !== state.policySha256) throw new Error("Action policy binding mismatch");
      if (!policy.authority.some((kind) => kind === event.operation.kind)) throw new Error("Operation outside policy authority");
      if (isSnapshotStewardshipPolicy(policy)) {
        const snapshot = event.snapshotSha256 && state.snapshots?.[event.snapshotSha256];
        if (!snapshot || snapshot.status !== "approved") throw new Error("Action requires approved snapshot target");
        const indices = snapshot.operations.flatMap((entry, index) => entry.issueNumber === event.issueNumber
          && canonicalJsonSha256(entry.operation) === canonicalJsonSha256(event.operation) ? [index] : []);
        if (indices.length === 0) throw new Error("Action requires approved snapshot target");
        if (indices.some((index) => snapshot.skips?.[index])) throw new Error("Snapshot operation was skipped");
        if (Object.values(state.actions).some((action) => action.snapshotSha256 === event.snapshotSha256 && (action.outcome === "not-applied" || action.outcome === "confirmed")
          && action.issueNumber === event.issueNumber && canonicalJsonSha256(action.operation) === canonicalJsonSha256(event.operation))) {
          throw new Error("Snapshot operation already confirmed or not-applied; replacement approval required");
        }
        const plan = snapshot.plans?.[event.runId];
        if (plan && indices.some((index) => plan.operations.find((operation) => operation.index === index)?.classification !== "send")) throw new Error("Snapshot plan does not classify operation as send");
      }
      const run = getRun(state, event.runId, at, policy); const issue = getIssue(state, event.issueNumber);
      if (Object.values(state.actions).some((action) => action.issueNumber === event.issueNumber && stewardshipActionBlocksIssue(state, action, event.snapshotSha256))) throw new Error("Issue quarantined by unresolved action");
      const targetField = ownOperationField(event.operation);
      if (targetField && observedField(issue, targetField, at).hold) throw new Error("Field is held");
      if (run.remoteMutations >= policy.limits.remoteMutations || (!run.mutatedIssues.includes(event.issueNumber) && run.mutatedIssues.length >= policy.limits.changedIssues)) throw new Error("Mutation budget exhausted");
      if (run.lastMutationAt !== null && Date.parse(at) - Date.parse(run.lastMutationAt) < policy.limits.mutationIntervalMs) throw new Error("Mutation pacing interval not reached");
      run.remoteMutations++; if (!run.mutatedIssues.includes(event.issueNumber)) run.mutatedIssues.push(event.issueNumber); run.lastMutationAt = at;
      state.actions[event.actionId] = { runId: event.runId, issueNumber: event.issueNumber, operation: event.operation, policySha256: event.policySha256, bindingSha256: event.bindingSha256, attemptedAt: at,
        ...(event.snapshotSha256 ? { snapshotSha256: event.snapshotSha256 } : {}), ...eventCompilerProvenance(event), outcome: null, receiptSha256: null, nativeEventIds: [] }; break;
    }
    case "action-outcome": {
      const action = state.actions[event.actionId];
      if (!action || action.outcome === "confirmed" || action.outcome === "not-applied" || (action.snapshotSha256 && action.outcome !== null)) throw new Error("Action missing or already terminal");
      if (event.outcome === "confirmed" && stewardshipOperationField(action.operation) === "Lifecycle") {
        const receipt = readArtifact(event.receiptSha256) as { lifecycle: unknown };
        (state.lifecycleReceipts ??= {})[action.issueNumber] = lifecycleReceiptSchema.parse(receipt.lifecycle);
      }
      action.outcome = event.outcome; action.receiptSha256 = event.receiptSha256; action.nativeEventIds = event.nativeEventIds ?? []; break;
    }
    case "run-finished": {
      const run = state.runs[event.runId]; if (!run || run.resultSha256 !== null) throw new Error("Run missing or already finished");
      run.resultSha256 = event.resultSha256; break;
    }
  }
}

function artifactReferences(event: StewardshipEvent): string[] {
  switch (event.type) {
    case "shadow-pass-started":
    case "shadow-census-observed": return [event.censusSha256];
    case "policy-upgraded":
    case "policy-changed": return [event.previousPolicySha256, event.policySha256];
    case "backlog-compiled":
    case "live-snapshot-compiled":
    case "snapshot-issue-skip":
    case "snapshot-approved": return [event.compileInputsSha256];
    case "snapshot-plan": return [event.compileInputsSha256, ...event.observationSha256s];
    case "action-attempted": return [event.bindingSha256, ...(event.operation.kind === "append_comment" ? [event.operation.bodySha256] : [])];
    case "action-outcome": return [event.receiptSha256];
    case "field-history-recovered": return [event.historySha256];
    case "evidence-recorded": return [event.packetSha256];
    case "issue-assessed": return [event.decisionSha256];
    case "hold-superseded": return event.assessmentSha256s;
    case "run-finished": return [event.resultSha256];
    case "issue-settled": return [event.executionSha256];
    case "report-delivery": return [event.reportSha256];
    default: return [];
  }
}

function validateArtifacts(event: StewardshipEvent, policySha256: string, state: StewardshipState,
  readArtifact: (hash: string) => unknown): void {
  for (const reference of artifactReferences(event)) readArtifact(reference);
  if (event.type === "action-attempted" && event.snapshotSha256) {
    const snapshot = state.snapshots?.[event.snapshotSha256];
    const binding = readArtifact(event.bindingSha256) as { schemaVersion: string; snapshotSha256: string; compileInputsSha256: string; operationIndex: number; beforeObservationSha256: string };
    const target = snapshot?.operations[binding.operationIndex];
    if (!snapshot || binding.schemaVersion !== "github-issue-roadmap-snapshot-execution/v1" || binding.snapshotSha256 !== event.snapshotSha256
      || binding.compileInputsSha256 !== snapshot.compileInputsSha256 || !Number.isSafeInteger(binding.operationIndex)
      || !target || target.issueNumber !== event.issueNumber || canonicalJsonSha256(target.operation) !== canonicalJsonSha256(event.operation)) throw new Error("Snapshot action binding mismatch");
    readArtifact(binding.beforeObservationSha256);
  }
  if (event.type === "action-outcome" && event.outcome === "confirmed") {
    const action = state.actions[event.actionId];
    if (action?.snapshotSha256) {
      const receipt = readArtifact(event.receiptSha256) as { schemaVersion: string; actionId: string; issueNumber: number; field: string;
        operation: StewardshipOperation; snapshotSha256: string; outcome: string; observationSha256: string; nativeEventIds: string[]; observedAt: string; lifecycle?: unknown };
      if (receipt.schemaVersion !== "github-issue-roadmap-sorter-receipt/v1" || receipt.actionId !== event.actionId || receipt.issueNumber !== action.issueNumber
        || receipt.field !== stewardshipOperationField(action.operation) || receipt.snapshotSha256 !== action.snapshotSha256 || receipt.outcome !== "confirmed"
        || canonicalJsonSha256(receipt.operation) !== canonicalJsonSha256(action.operation) || !event.nativeEventIds?.length
        || canonicalJsonSha256(receipt.nativeEventIds) !== canonicalJsonSha256(event.nativeEventIds)) throw new Error("Snapshot receipt binding mismatch");
      const after = readArtifact(receipt.observationSha256) as StewardshipObservation;
      if (receipt.field === "Lifecycle") {
        const binding = readArtifact(action.bindingSha256) as { beforeObservationSha256: string };
        const before = readArtifact(binding.beforeObservationSha256) as StewardshipObservation;
        const compile = readArtifact(state.snapshots![action.snapshotSha256].compileInputsSha256) as Parameters<typeof compileStewardshipBacklog>[0];
        const lifecycle = createStewardshipLifecycleReceipt({ issueNumber: action.issueNumber, snapshotSha256: action.snapshotSha256,
          compile, readArtifact, after, nativeEventId: event.nativeEventIds[0], confirmedAt: receipt.observedAt });
        const history = after.evidence.packet.fieldHistory.Lifecycle;
        const additions = history?.events.filter((entry) => !before.evidence.packet.fieldHistory.Lifecycle?.frontier.eventIds.includes(entry.id));
        if (event.nativeEventIds.length !== 1 || additions?.length !== 1 || additions[0].id !== lifecycle.fieldEvent.id
          || !history?.frontier.complete || lifecycle.value !== stewardshipOperationValue(action.operation)
          || canonicalJsonSha256(additions[0].values) !== canonicalJsonSha256(lifecycle.value === null ? [] : [lifecycle.value])
          || Date.parse(lifecycle.fieldEvent.createdAt) < Math.floor(Date.parse(action.attemptedAt) / 1000) * 1000
          || canonicalJsonSha256(lifecycle) !== canonicalJsonSha256(lifecycleReceiptSchema.parse(receipt.lifecycle))) throw new Error("Lifecycle receipt binding mismatch");
      }
    }
  }
  if (event.type === "policy-changed" || event.type === "policy-upgraded") {
    const previous = readArtifact(event.previousPolicySha256);
    const next = readArtifact(event.policySha256);
    resolveStewardshipPolicy(event.policySha256, parseStewardshipPolicy(previous));
    (event.type === "policy-upgraded" ? validateStewardshipPolicyUpgrade : validateStewardshipPolicyChange)(previous, next);
    if (stewardshipPolicySha256(previous) !== policySha256) throw new Error("Archived policy epoch mismatch");
  }
  if (event.type === "evidence-recorded") {
    const packet = readArtifact(event.packetSha256) as StewardshipIssueEvidencePacket;
    if ((event.policySha256 !== undefined && event.policySha256 !== policySha256)
      || packet.issueNumber !== event.issueNumber || packet.materialEvidenceSha256 !== event.materialEvidenceSha256
      || stewardshipPacketMaterialSha256(packet, event.originMainSha, policySha256) !== event.materialEvidenceSha256) throw new Error("Archived evidence identity mismatch");
  }
  if (event.type === "issue-settled") {
    const execution = readArtifact(event.executionSha256) as Record<string, unknown>;
    if (execution.issueNumber !== event.issueNumber || execution.status !== "updated"
      || execution.finalMaterialEvidenceSha256 !== event.materialEvidenceSha256
      || !Array.isArray(execution.confirmedActionIds) || execution.confirmedActionIds.length === 0
      || !execution.confirmedActionIds.every((id) => typeof id === "string" && state.actions[id]?.outcome === "confirmed"
        && state.actions[id].issueNumber === event.issueNumber && state.actions[id].runId === event.runId)) throw new Error("Settlement requires confirmed final execution");
    const last = state.actions[execution.confirmedActionIds.at(-1) as string];
    const receipt = readArtifact(last.receiptSha256!) as { observationSha256?: string; sourceDrift?: boolean };
    if (receipt.sourceDrift || receipt.observationSha256 !== execution.finalObservationSha256 || !receipt.observationSha256) throw new Error("Settlement requires exact final receipt");
    const observation = readArtifact(receipt.observationSha256) as { evidence: { packet: StewardshipIssueEvidencePacket } };
    if (observation.evidence.packet.materialEvidenceSha256 !== event.materialEvidenceSha256) throw new Error("Settlement material mismatch");
  }
}

function replay(input: StewardshipLocation, journalBytes?: string, artifactReader?: (hash: string) => unknown) {
  const { policy, paths } = validateLocation(input);
  const cache = input.artifactCache ?? createStewardshipArtifactCache();
  const read = artifactReader ?? ((hash: string) => cache.read(paths.artifacts, hash));
  let bytes: string;
  try { bytes = journalBytes ?? readFileSync(paths.journal, "utf8"); }
  catch (error) {
    // Only absence means "missing"; an unreadable journal must not send the operator to re-initialize.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error("Stewardship journal missing; explicit initialization or recovery required");
  }
  if (!bytes.endsWith("\n")) throw new Error("Torn or corrupt stewardship journal; recovery required");
  let state: StewardshipState | undefined;
  const journal: { event: StewardshipEvent; at: string }[] = [];
  let previousControlPolicy: string | null = null;
  for (const line of bytes.slice(0, -1).split("\n")) {
    const record = recordSchema.parse(JSON.parse(line));
    const { sha256, ...core } = record;
    if (canonicalJsonSha256(core) !== sha256 || record.sequence !== (state?.sequence ?? 0) + 1 || record.previousSha256 !== (state?.headSha256 ?? null)) throw new Error("Stewardship journal hash chain corruption");
    if (!state) {
      if (record.event.type !== "initialized") throw new Error("Missing adoption initialization");
      resolveStewardshipPolicy(record.event.policySha256, policy);
      const initialization = record.event.initialization;
      if (record.at !== initialization.at) throw new Error("Adoption timestamp mismatch");
      state = { adoptionId: initialization.adoptionId, repository: policy.repository, policySha256: record.event.policySha256, initializedAt: record.at,
        paused: false, sequence: 0, headSha256: "", issues: Object.create(null), runs: Object.create(null), actions: Object.create(null) };
      const baselinePolicy = resolveStewardshipPolicy(state.policySha256, policy);
      if (isSnapshotStewardshipPolicy(baselinePolicy)) state.snapshotAdoptedAt = record.at;
      const writesSortKey = stewardshipWritableFields(baselinePolicy).includes("Sort key");
      for (const baseline of initialization.census.issues) addBaseline(state, baseline, writesSortKey);
    } else {
      const epoch = resolveStewardshipPolicy(state.policySha256, policy);
      validateArtifacts(record.event, state.policySha256, state, read);
      reduce(state, record.event, record.at, epoch, read, journal);
    }
    previousControlPolicy = record.event.type === "policy-changed" || record.event.type === "policy-upgraded" ? record.event.previousPolicySha256 : null;
    state.sequence = record.sequence; state.headSha256 = sha256;
    journal.push({ event: record.event, at: record.at });
  }
  if (!state) throw new Error("Empty adoption journal");
  return { state, previousControlPolicy, journal };
}
function readControl(input: StewardshipLocation, state: StewardshipState, previousControlPolicy: string | null = null) {
  const { paths } = validateLocation(input);
  let value: unknown;
  try { value = JSON.parse(readFileSync(paths.control, "utf8")); } catch { throw new Error("Active stewardship control missing or corrupt; recovery required"); }
  const control = controlSchema.parse(value); const { sha256, ...core } = control;
  if (canonicalJsonSha256(core) !== sha256 || control.repository !== state.repository || control.adoptionId !== state.adoptionId
    || (control.policySha256 !== state.policySha256 && control.policySha256 !== previousControlPolicy)) throw new Error("Active stewardship control binding corruption");
  return control;
}
export function readStewardshipState(input: StewardshipLocation, journalBytes?: string): StewardshipState {
  const { state, previousControlPolicy } = replay(input, journalBytes);
  state.paused = readControl(input, state, previousControlPolicy).paused;
  assertCurrentPolicy(input, state); return state;
}
export function readStewardshipControlPolicy(input: StewardshipLocation): string {
  const { state, previousControlPolicy } = replay(input);
  return readControl(input, state, previousControlPolicy).policySha256;
}
/** receipts/v2 is an optional, read-only extension of every v1 field. Consumers
 * must whitelist known affirmative values: null, missing fields and unknown
 * values mean do not treat as fresh / do not close. PR attribution describes
 * only cited frozen evidence, never whether the change is still present on main.
 * A future optional verificationReceipt reference has independent semantics.
 */
const lifecycleJudgmentReasonSchema = z.enum(["seat_calls_in_compile_run", "assessment_reused", "mixed_seat_provenance",
  "compile_run_missing", "compile_run_ambiguous", "assessment_missing", "assessment_event_missing", "assessment_event_ambiguous", "seat_call_unproven"]);
const lifecycleSeatProvenanceSchema = z.object({
  seat: seatFamily, envelopeSha256: hash,
  producedBy: z.object({ eventType: z.literal("issue-assessed"), runId: id, sequence: issueNumber }).strict().nullable(),
  provenanceReason: lifecycleJudgmentReasonSchema.nullable(),
  evidence: z.object({ packetSha256: hash, materialEvidenceSha256: hash, capturedAt: instant.nullable(),
    capturedAtReason: z.enum(["capture_time_missing", "capture_time_ambiguous"]).nullable() }).strict(),
}).strict();
type LifecycleSeatProvenance = z.infer<typeof lifecycleSeatProvenanceSchema>;
// EXACT output key allowlist; strict parsing prevents text-bearing assessment
// keys (including rationale, reason and code quotes) from entering a verdict.
const lifecycleCriterionSchema = z.discriminatedUnion("field", [
  z.object({ criterionId: z.literal("completion"), field: z.literal("completion"), value: z.enum(["unfulfilled", "complete", "uncertain"]) }).strict(),
  z.object({ criterionId: z.literal("ranking.doneStale"), field: z.literal("doneStale"), status: z.enum(["assessed", "abstain"]).nullable(),
    value: z.enum(["done", "stale", "no"]).nullable(), reason: z.enum(["criterion_not_carried", "seat_abstained"]).nullable() }).strict(),
  z.object({ criterionId: z.string().min(1).max(160), field: z.literal("clause"), status: z.enum(["unfulfilled", "fulfilled", "unknown"]) }).strict(),
]);
const lifecyclePullRequestCandidateSchema = z.object({
  kind: z.enum(["pull_request", "merge_commit"]), value: z.union([issueNumber, z.string().regex(/^[a-f0-9]{40,64}$/)]),
  basis: z.enum(["closing_reference", "linked", "commit"]), mergedAt: instant.nullable(), headSha: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
}).strict();
type LifecyclePullRequestCandidate = z.infer<typeof lifecyclePullRequestCandidateSchema>;
const lifecycleEnrichmentSchema = z.object({
  coverageOutcome: z.object({ outcome: z.literal("glm_refused"), reason: z.literal("local_path"), seat: z.literal("codex"),
    packetSha256: hash, assessmentSha256: hash, currencyKey: hash, assessedAt: instant }).strict().optional(),
  runId: id.nullable().optional(), runIdReason: z.enum(["compile_run_missing", "compile_run_ambiguous"]).nullable().optional(),
  sequence: issueNumber.nullable().optional(), assessmentSha256s: z.array(hash).nullable().optional(),
  seats: z.array(lifecycleSeatProvenanceSchema.extend({ judgment: z.enum(["fresh", "cached"]).nullable(), judgmentReason: lifecycleJudgmentReasonSchema }).strict()).optional(),
  judgment: z.enum(["fresh", "cached"]).nullable().optional(), judgmentReason: lifecycleJudgmentReasonSchema.optional(),
  criterionVerdicts: z.array(z.object({ seat: seatFamily, criteria: z.array(lifecycleCriterionSchema) }).strict()).optional(),
  evidenceResolvedPullRequest: z.object({ candidates: z.array(lifecyclePullRequestCandidateSchema), chosen: lifecyclePullRequestCandidateSchema.nullable(),
    reason: z.enum(["unique_best_basis", "ambiguous_best_basis", "no_pull_request_evidence_cited", "no_pull_request_in_cited_evidence", "assessment_missing"]),
    reversion: z.literal("not_captured") }).strict().optional(),
  writeRunId: id.nullable().optional(), writeRunIdReason: z.literal("write_event_missing").nullable().optional(),
}).strict();

/** The sole freshness predicate, shared by the pair and each individual seat.
 * Hashes locate content; only journal event identity establishes production.
 */
function lifecycleJudgment(seats: readonly LifecycleSeatProvenance[], runId: string | null,
  runReason: "compile_run_missing" | "compile_run_ambiguous" | null) {
  if (runId === null) return { judgment: null, judgmentReason: runReason ?? "compile_run_missing" } as const;
  if (!seats.length) return { judgment: null, judgmentReason: "assessment_missing" } as const;
  const unknown = seats.find((seat) => seat.producedBy === null);
  if (unknown) return { judgment: null, judgmentReason: unknown.provenanceReason ?? "seat_call_unproven" } as const;
  const fresh = seats.filter((seat) => seat.producedBy!.runId === runId).length;
  return fresh === seats.length ? { judgment: "fresh", judgmentReason: "seat_calls_in_compile_run" } as const
    : fresh === 0 ? { judgment: "cached", judgmentReason: "assessment_reused" } as const
    : { judgment: null, judgmentReason: "mixed_seat_provenance" } as const;
}
function lifecycleCriteria(envelope: StewardshipAssessmentEnvelope) {
  const assessment = envelope.assessment;
  const doneStale = "ranking" in assessment ? assessment.ranking.doneStale : null;
  return { seat: envelope.seat.family, criteria: [
    lifecycleCriterionSchema.parse({ criterionId: "completion", field: "completion", value: assessment.completion }),
    lifecycleCriterionSchema.parse({ criterionId: "ranking.doneStale", field: "doneStale", status: doneStale?.status ?? null,
      value: doneStale?.status === "assessed" ? doneStale.value : null,
      reason: doneStale === null ? "criterion_not_carried" : doneStale.status === "abstain" ? "seat_abstained" : null }),
    ...assessment.clauses.map(({ clauseId, status }) => lifecycleCriterionSchema.parse({ criterionId: clauseId, field: "clause", status })),
  ] };
}
function lifecyclePullRequests(envelopes: readonly StewardshipAssessmentEnvelope[], read: (hash: string) => unknown) {
  const candidates = new Map<string, LifecyclePullRequestCandidate>();
  let cited = false;
  for (const { assessment } of envelopes) {
    const packet = read(assessment.binding.packetSha256) as StewardshipIssueEvidencePacket;
    // The collector's merged_work fact cites the whole frozen PR set. It does
    // not identify one PR; multiple references remain explicit candidates.
    const evidenceIds = new Set([...assessment.evidenceIds, ...assessment.counterevidenceIds, ...assessment.sequencing.evidenceIds,
      ...(assessment.revisitTrigger?.evidenceIds ?? []), ...(assessment.demotion?.evidenceIds ?? []),
      ...(assessment.supersedesHold?.changedFactIds ?? []), ...assessment.clauses.flatMap((clause) => clause.codeReferences.map(({ evidenceId }) => evidenceId)),
      ...Object.values(assessment.rubricFacts).flatMap((claim) => claim?.evidenceIds ?? [])]);
    if (!packet.facts.some((fact) => evidenceIds.has(fact.factId) && fact.kind === "merged_work"
      && fact.locator === `issue:${packet.issueNumber}:pull-requests`
      && fact.contentSha256 === canonicalJsonSha256(packet.issue.pullRequests))) continue;
    cited = true;
    for (const pr of packet.issue.pullRequests) {
      const candidate = lifecyclePullRequestCandidateSchema.parse({ kind: "pull_request", value: pr.identity.number,
        basis: pr.relationship === "closing" ? "closing_reference" : "linked", mergedAt: pr.mergedAt, headSha: pr.headSha });
      candidates.set(canonicalJson(candidate), candidate);
    }
  }
  const priority = { closing_reference: 0, linked: 1, commit: 2 };
  const values = [...candidates.values()].sort((a, b) => priority[a.basis] - priority[b.basis]
    || (canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0));
  const best = values.filter((candidate) => candidate.basis === values[0]?.basis);
  return { candidates: values, chosen: best.length === 1 ? best[0] : null,
    reason: !envelopes.length ? "assessment_missing" as const : best.length === 1 ? "unique_best_basis" as const
      : best.length > 1 ? "ambiguous_best_basis" as const : cited ? "no_pull_request_in_cited_evidence" as const : "no_pull_request_evidence_cited" as const,
    reversion: "not_captured" as const };
}
function enrichLifecycleReceipts(v1: { generatedAt: string; repository: string; receipts: StewardshipLifecycleReceipt[]; observations: LifecycleObservation[] },
  state: StewardshipState, journal: readonly { event: StewardshipEvent; at: string }[], read: (hash: string) => unknown) {
  const assessed: { event: Extract<StewardshipEvent, { type: "issue-assessed" }>; at: string; sequence: number; hashes: string[] }[] = [];
  const compiles: { event: Extract<StewardshipEvent, { type: "backlog-compiled" }>; at: string; index: number;
    runId: string | null; runIdReason: "compile_run_missing" | "compile_run_ambiguous" | null }[] = [];
  const writeIndexes = new Map<string, number>();
  let latestCompile: Extract<StewardshipEvent, { type: "backlog-compiled" }> | undefined;
  const active = new Set<string>();
  journal.forEach(({ event, at }, index) => {
    if (event.type === "run-started") active.add(event.runId);
    if (event.type === "run-finished") active.delete(event.runId);
    if (event.type === "action-attempted") writeIndexes.set(event.actionId, index);
    if (event.type === "issue-assessed") {
      const decision = read(event.decisionSha256) as { assessmentSha256s?: string[] };
      assessed.push({ event, at, sequence: index + 1, hashes: z.array(hash).parse(decision.assessmentSha256s ?? []) });
    }
    if (event.type === "backlog-compiled") latestCompile = event;
    if (event.type === "backlog-compiled" && event.approvalEligible !== false) {
      const runId = event.liveRunId ?? (active.size === 1 ? active.values().next().value! : null);
      compiles.push({ event, at, index, runId,
        runIdReason: runId !== null ? null : active.size > 1 ? "compile_run_ambiguous" : "compile_run_missing" });
    }
  });
  const enrich = (number: number, snapshotSha256: string, compiledAt?: string, writeIndex?: number) => {
    const matches = compiles.filter(({ event, at, index }) => event.snapshotSha256 === snapshotSha256
      && (compiledAt === undefined || at === compiledAt) && (writeIndex === undefined || index < writeIndex));
    const selectedCompile = matches[0];
    const compileIndex = selectedCompile?.index ?? -1;
    const compile = selectedCompile?.event;
    // A receipt has no compile timestamp to distinguish repeated eligible compiles.
    const ambiguous = compiledAt === undefined && matches.length > 1;
    const runId = ambiguous ? null : selectedCompile?.runId ?? null;
    const runIdReason = runId !== null ? null : ambiguous ? "compile_run_ambiguous" as const : selectedCompile?.runIdReason ?? "compile_run_missing" as const;
    const inputsHash = compile?.compileInputsSha256 ?? state.snapshots?.[snapshotSha256]?.compileInputsSha256;
    const input = inputsHash ? read(inputsHash) as Parameters<typeof compileStewardshipBacklog>[0] : null;
    const projected = input?.projection.issues[number]?.assessment;
    const envelopes = projected?.assessments.map((envelope) => stewardshipAssessmentEnvelopeSchema.parse(read(canonicalJsonSha256(envelope)))) ?? [];
    const hashes = envelopes.map(canonicalJsonSha256);
    const decisions = assessed.filter((entry) => entry.sequence <= compileIndex && entry.event.issueNumber === number
      && entry.at === projected?.assessedAt && canonicalJson([...entry.hashes].sort()) === canonicalJson([...hashes].sort()));
    // Projection pairs are traversed in reverse journal order (projection.ts).
    // Preserve that selection rule even when fresh calls reproduce both the
    // envelope bytes and timestamp: the later event has its own producer identity.
    const selected = decisions.at(-1) ?? null;
    const seats = envelopes.map((envelope): LifecycleSeatProvenance => {
      const envelopeSha256 = canonicalJsonSha256(envelope);
      const called = (entry: typeof assessed[number]) => entry.event.usage?.seats.some(({ seat }) => seat === envelope.seat.family) === true;
      const prior = selected?.event.usage !== undefined && !called(selected) ? assessed.filter((entry) => entry.sequence < selected.sequence
        && entry.event.issueNumber === number && entry.hashes.includes(envelopeSha256) && called(entry)) : [];
      const producer = selected && called(selected) ? selected : prior.length === 1 ? prior[0] : null;
      const packet = read(envelope.assessment.binding.packetSha256) as StewardshipIssueEvidencePacket;
      const times = [...new Set(packet.issue.transport.map(({ fetchedAt }) => fetchedAt))];
      return lifecycleSeatProvenanceSchema.parse({ seat: envelope.seat.family, envelopeSha256,
        producedBy: producer ? { eventType: producer.event.type, runId: producer.event.runId, sequence: producer.sequence } : null,
        provenanceReason: producer ? null : prior.length > 1 ? "assessment_event_ambiguous" : selected ? "seat_call_unproven" : "assessment_event_missing",
        evidence: { packetSha256: envelope.assessment.binding.packetSha256, materialEvidenceSha256: envelope.assessment.binding.materialEvidenceSha256,
          capturedAt: times.length === 1 ? times[0] : null, capturedAtReason: times.length === 1 ? null : times.length ? "capture_time_ambiguous" : "capture_time_missing" } });
    });
    return lifecycleEnrichmentSchema.parse({ runId, runIdReason, sequence: compileIndex < 0 ? null : compileIndex + 1,
      ...(input?.projection.issues[number]?.coverageOutcome ? { coverageOutcome: input.projection.issues[number].coverageOutcome } : {}),
      assessmentSha256s: hashes.length ? hashes : null, ...lifecycleJudgment(seats, runId, runIdReason),
      seats: seats.map((seat) => ({ ...seat, ...lifecycleJudgment([seat], runId, runIdReason) })),
      criterionVerdicts: envelopes.map(lifecycleCriteria), evidenceResolvedPullRequest: lifecyclePullRequests(envelopes, read) });
  };
  const latestInput = latestCompile ? read(latestCompile.compileInputsSha256) as Parameters<typeof compileStewardshipBacklog>[0] : undefined;
  const settledWithoutGlm = (latestInput?.projection.coverage.settledWithoutGlm ?? []).map(({ issueNumber, ...outcome }) => ({ issueNumber,
    ...lifecycleEnrichmentSchema.shape.coverageOutcome.unwrap().parse(outcome) }));
  return { schemaVersion: "github-issue-roadmap-lifecycle-receipts/v2" as const, generatedAt: v1.generatedAt, repository: v1.repository,
    ...(settledWithoutGlm.length ? { settledWithoutGlm } : {}),
    receipts: v1.receipts.map((receipt) => {
      const entry = Object.entries(state.actions).find(([, action]) => action.issueNumber === receipt.issueNumber && action.snapshotSha256 === receipt.snapshotSha256
        && action.outcome === "confirmed" && action.nativeEventIds.includes(receipt.fieldEvent.id));
      return { ...receipt, ...enrich(receipt.issueNumber, receipt.snapshotSha256, undefined, entry ? writeIndexes.get(entry[0]) : undefined),
        writeRunId: entry?.[1].runId ?? null, writeRunIdReason: entry ? null : "write_event_missing" as const };
    }), observations: v1.observations.map((observation) => ({ ...observation, ...enrich(observation.issueNumber, observation.compileSnapshotSha256, observation.compiledAt) })) };
}
/** Read-only ownership of the host-lock/v2 endpoint. The writer helper updates
 * owner.json, so readers bind the same OS lock without changing its permanent barrier. */
export async function readStewardshipLifecycleReceipts(input: StewardshipLocation & { generatedAt: string; schema?: "v1" | "v2" }) {
  instant.parse(input.generatedAt);
  z.enum(["v1", "v2"]).parse(input.schema ?? "v1");
  validateLocation(input);
  // Fixed host-lock/v2 barrier and port mapping; keep this adapter read-only.
  const digest = createHash("sha256").update(input.repository.toLowerCase(), "utf8").digest();
  const lockPath = join(resolve(input.root ?? defaultHostRoadmapControlRoot()), "locks", `${digest.toString("hex")}.lock`);
  if (!existsSync(lockPath) || !lstatSync(lockPath).isDirectory()) throw new Error("Read-only export requires an existing host-lock/v2 barrier");
  // Fixed protocol mapping from host-lock.ts; an occupied endpoint always refuses.
  const port = input.hostLockPort ?? hostRepositoryLockPort(input.repository);
  const listener = createServer((socket) => socket.destroy());
  await new Promise<void>((accept, reject) => {
    listener.once("error", reject);
    listener.listen({ host: "127.0.0.1", port, exclusive: true }, () => { listener.removeListener("error", reject); accept(); });
  });
  try {
    const location = { ...input, allowPolicyMismatch: true, artifactCache: input.artifactCache ?? createStewardshipArtifactCache() };
    const artifacts = stewardshipPaths(input).artifacts;
    const read = (hash: string) => location.artifactCache.read(artifacts, hash);
    const replayed = input.schema === "v2" ? replay(location, undefined, read) : null;
    const state = replayed?.state ?? readStewardshipState(location);
    if (replayed) {
      state.paused = readControl(location, state, replayed.previousControlPolicy).paused;
      assertCurrentPolicy(location, state);
    }
    const v1 = { schemaVersion: "github-issue-roadmap-lifecycle-receipts/v1" as const, generatedAt: input.generatedAt,
      repository: state.repository, receipts: Object.values(state.lifecycleReceipts ?? {}).sort((a, b) => a.issueNumber - b.issueNumber),
      observations: state.lifecycleObservations ?? [] };
    if (!replayed) return v1;
    return enrichLifecycleReceipts(v1, state, replayed.journal, read);
  } finally { await new Promise<void>((done, reject) => listener.close((error) => error ? reject(error) : done())); }
}

function assertCurrentPolicy(input: StewardshipLocation, state: StewardshipState) {
  const expected = stewardshipPolicySha256(input.policy);
  if (!input.allowPolicyMismatch && state.policySha256 !== expected) throw new Error(`Pending policy change ${state.policySha256} -> ${expected}; run ${isSnapshotStewardshipPolicy(input.policy) ? "policy-upgrade" : "policy-update"} before this command`);
}

function writeControl(input: StewardshipLocation, state: StewardshipState, paused: boolean, at: string, initialize = false) {
  instant.parse(at); const { paths } = validateLocation(input);
  const core = { schemaVersion: "github-issue-roadmap-stewardship-control/v1", repository: state.repository, adoptionId: state.adoptionId,
    policySha256: state.policySha256, paused, at, nonce: randomUUID() };
  const text = `${canonicalJson({ ...core, sha256: canonicalJsonSha256(core) })}\n`;
  if (initialize) { durableWrite(paths.control, text, "wx"); return; }
  const temporary = join(paths.directory, `control-${core.nonce}.tmp`);
  durableWrite(temporary, text, "wx"); renameSync(temporary, paths.control);
}
/** Deliberately independent of the run's long-lived listener: pause is visible at each mutation admission. */
export function setStewardshipPaused(input: StewardshipLocation & { paused: boolean; at: string }): void {
  const state = readStewardshipState({ ...input, allowPolicyMismatch: false });
  // A policy crash must first be repaired by the lock-owning store, never by pause.
  readControl(input, state);
  writeControl(input, state, input.paused, input.at);
}

export interface StewardshipStore {
  readonly state: StewardshipState;
  append(event: StewardshipEvent, at: string): StewardshipState;
  archive(value: unknown): string;
  archiveRejected(runId: string, answer: StewardshipRejectedAnswer, diagnostic: StewardshipDiagnostic, at: string): void;
  /** Immutable value; clone it before constructing a modified artifact. */
  readArtifact(sha256: string): unknown;
  release(): void;
}
const previewStoreBrand = Symbol("stewardship-preview-store");
export type StewardshipPreviewStore = StewardshipStore & { readonly [previewStoreBrand]: true };
const previewStores = new WeakSet<StewardshipStore>();
export function isStewardshipPreviewStore(store: StewardshipStore): boolean {
  return previewStores.has(store) && Object.getOwnPropertyDescriptor(store, previewStoreBrand)?.value === true;
}

function journalIdentity(path: string): string {
  const stat = statSync(path, { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

/** The cycle acquires once, and passes this store to under-lock executor code. Never nest a legacy executor. */
export async function acquireStewardshipStore(input: StewardshipLocation & { owner: string; initialize?: StewardshipInitialization | (() => Promise<StewardshipInitialization>) }): Promise<StewardshipStore> {
  const cache = input.artifactCache ?? createStewardshipArtifactCache();
  input = { ...input, artifactCache: cache };
  const { paths, policy } = validateLocation(input);
  const read = (sha256: string) => cache.read(paths.artifacts, sha256);
  const lock = await acquireHostRepositoryLock({ root: input.root, repository: input.repository, owner: input.owner, hostLockPort: input.hostLockPort });
  let released = false;
  const assertOwned = () => { if (released) throw new Error("Stewardship ownership released"); };
  const release = () => { if (!released) { released = true; lock.release(); } };
  try {
    if (input.initialize) {
      if (existsSync(paths.directory)) throw new Error("Stewardship adoption already exists or is interrupted; recovery required");
      const initialization = initializationSchema.parse(typeof input.initialize === "function" ? await input.initialize() : input.initialize);
      // Claim the adoption pathname before any file. A crash here must never silently initialize again.
      mkdirSync(paths.directory, { recursive: true, mode: 0o700 }); mkdirSync(paths.artifacts, { mode: 0o700 });
      const event: StewardshipEvent = { type: "initialized", initialization, policySha256: stewardshipPolicySha256(policy) };
      const core = { schemaVersion: "github-issue-roadmap-stewardship-journal/v1", sequence: 1, previousSha256: null, at: initialization.at, event };
      durableWrite(paths.journal, `${canonicalJson({ ...core, sha256: canonicalJsonSha256(core) })}\n`, "wx");
      writeControl(input, replay(input).state, false, initialization.at, true);
    }
    const replayed = replay(input);
    let cached = replayed.state;
    const journal = replayed.journal;
    const control = readControl(input, cached, replayed.previousControlPolicy);
    cached.paused = control.paused;
    if (control.policySha256 !== cached.policySha256) writeControl(input, cached, control.paused, control.at);
    assertCurrentPolicy(input, cached);
    let expectedJournal = journalIdentity(paths.journal);
    let poisoned = false;
    const currentState = () => {
      assertOwned();
      if (poisoned || journalIdentity(paths.journal) !== expectedJournal) throw new Error("Stewardship journal changed or prior append failed; reacquire and validate before proceeding");
      cached.paused = readControl(input, cached).paused;
      return structuredClone(cached);
    };
    const store: StewardshipStore = {
      get state() { return currentState(); },
      append(value, at) {
        rejectRehearsalArtifact(value);
        assertOwned(); instant.parse(at); let event = stewardshipEventSchema.parse(value);
        // Admission-only artifact guard: historical replay performs no extra reads.
        if (event.type === "action-outcome") rejectRehearsalArtifact(read(event.receiptSha256));
        if (event.type === "run-finished") rejectRehearsalArtifact(read(event.resultSha256));
        let state = currentState();
        if (state.policySha256 !== stewardshipPolicySha256(policy) && event.type !== "policy-changed" && event.type !== "policy-upgraded" && event.type !== "run-finished") {
          assertCurrentPolicy({ ...input, allowPolicyMismatch: false }, state);
        }
        if (event.type === "evidence-recorded") event = { ...event, policySha256: event.policySha256 ?? state.policySha256 };
        if (state.paused && ["action-attempted", "assessment-started", "expansion-reserved"].includes(event.type)) throw new StewardshipReservationRefusal("paused", "Stewardship is paused");
        validateArtifacts(event, state.policySha256, state, read);
        const heldApproval = Boolean(event.type === "snapshot-approved" && stewardshipHeldSnapshot(state, read));
        reduce(state, event, at, resolveStewardshipPolicy(state.policySha256, policy), read, journal);
        // Admission changes; historical journal events retain their original replay rules.
        if (event.type === "action-attempted" && event.snapshotSha256 && !state.snapshots?.[event.snapshotSha256]?.plans?.[event.runId]) {
          throw new Error("Snapshot attempt requires a plan for this run");
        }
        if (event.type === "snapshot-approved" && !heldApproval) {
          // Validate approval before writing anything, then journal its compile
          // separately so eligible ready compiles have one observation source,
          // whether approved or unapproved. Partial and drifted compiles do not count.
          store.append({ type: "backlog-compiled", snapshotSha256: event.snapshotSha256, compileInputsSha256: event.compileInputsSha256 }, at);
          state = currentState();
          reduce(state, event, at, resolveStewardshipPolicy(state.policySha256, policy), read, journal);
        }
        if (event.type === "backlog-compiled") {
          const input = read(event.compileInputsSha256) as Parameters<typeof compileStewardshipBacklog>[0];
          event = { ...event, compiledAt: at, lifecycleTargets: lifecycleCompileTargets(compileStewardshipBacklog(input)) };
        }
        if (event.type === "run-started") purgeRejectedAnswers(paths.rejectedAnswers, at);
        const core = { schemaVersion: "github-issue-roadmap-stewardship-journal/v1", sequence: state.sequence + 1, previousSha256: state.headSha256, at, event };
        const sha256 = canonicalJsonSha256(core);
        try { durableWrite(paths.journal, `${canonicalJson({ ...core, sha256 })}\n`, "a"); }
        catch (error) { poisoned = true; throw error; }
        state.sequence++; state.headSha256 = sha256;
        expectedJournal = journalIdentity(paths.journal); cached = state;
        journal.push({ event, at });
        if (event.type === "policy-changed" || event.type === "policy-upgraded") {
          try { writeControl(input, state, state.paused, at); }
          catch (error) { poisoned = true; throw error; }
        }
        return structuredClone(state);
      },
      archive(value) {
        rejectRehearsalArtifact(value);
        assertOwned(); const text = canonicalJson(value); if (typeof text !== "string") throw new Error("Artifact must be JSON");
        const parsed: unknown = JSON.parse(text); const sha256 = canonicalJsonSha256(parsed); const path = join(paths.artifacts, `${sha256}.json`);
        try { durableWrite(path, `${text}\n`, "wx"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          // Admission checks must observe disk even when an earlier read is cached.
          readVerifiedImmutableJson(path, sha256);
        }
        return sha256;
      },
      archiveRejected(runId, answer, diagnostic, at) {
        const state = currentState(); id.parse(runId); instant.parse(at);
        const run = state.runs[runId];
        if (!run || run.resultSha256 !== null) throw new Error("Run missing or already finished");
        const event = stewardshipEventSchema.parse({ type: "assessment-rejected", seat: diagnostic.seat, stage: diagnostic.stage,
          code: diagnostic.code, field: diagnostic.field, contentSha256: answer.sha256 });
        if (!Number.isSafeInteger(answer.byteLength) || answer.byteLength < 0) throw new Error("Invalid rejected-answer length");
        if (answer.content !== undefined && (Buffer.byteLength(answer.content) !== answer.byteLength
          || sha256Bytes(answer.content) !== answer.sha256)) throw new Error("Rejected-answer identity mismatch");
        secureRejectedDirectory(paths.rejectedAnswers);
        const prefix = `${canonicalJsonSha256(runId)}-`; const name = `${prefix}${answer.sha256}.json`;
        const used = rejectedFiles(paths.rejectedAnswers).filter((entry) => entry.name.startsWith(prefix) && entry.name !== name)
          .reduce((total, entry) => total + entry.stat.size, 0);
        const metadata = { sha256: answer.sha256, byteLength: answer.byteLength };
        let text = `${canonicalJson({ ...metadata, ...(answer.content !== undefined ? { content: answer.content } : {}) })}\n`;
        if (used + Buffer.byteLength(text) > REJECTED_ANSWER_RUN_BYTES) text = `${canonicalJson(metadata)}\n`;
        const path = join(paths.rejectedAnswers, name);
        // A private temporary file and rename avoid exposing a partial diagnostic entry after a crash.
        const temporary = join(paths.rejectedAnswers, `${prefix}${randomUUID()}.tmp`);
        try {
          durableWrite(temporary, text, "wx"); renameSync(temporary, path);
          utimesSync(path, new Date(at), new Date(at));
        } finally { if (existsSync(temporary)) unlinkSync(temporary); }
        store.append(event, at);
      },
      readArtifact(sha256) { assertOwned(); return read(sha256); }, release,
    };
    return store;
  } catch (error) { release(); throw error; }
}

/** Preview reuses the reducer and archives in memory; no lock, journal, control or artifact writes. */
export function createStewardshipPreviewStore(input: { state: StewardshipState; policy: StewardshipPolicy;
  readArtifact: (sha256: string) => unknown; onEvent: (event: StewardshipEvent, at: string) => void; onArchive?: () => void }): StewardshipPreviewStore {
  let state = structuredClone(input.state);
  const artifacts = new Map<string, unknown>();
  const store: StewardshipStore = {
    get state() { return structuredClone(state); },
    append(value, at) {
      const event = stewardshipEventSchema.parse(value); instant.parse(at);
      const next = structuredClone(state); reduce(next, event, at, input.policy, (hash) => artifacts.has(hash) ? artifacts.get(hash) : input.readArtifact(hash)); next.sequence++;
      if (event.type === "action-attempted" && event.snapshotSha256 && !next.snapshots?.[event.snapshotSha256]?.plans?.[event.runId]) {
        throw new Error("Snapshot attempt requires a plan for this run");
      }
      state = next; input.onEvent(event, at); return structuredClone(state);
    },
    archive(value) { const hash = canonicalJsonSha256(value); artifacts.set(hash, structuredClone(value)); input.onArchive?.(); return hash; },
    readArtifact(hash) { return artifacts.has(hash) ? structuredClone(artifacts.get(hash)) : input.readArtifact(hash); },
    archiveRejected() { /* Preview has no rejected-answer retention. */ },
    release() { /* No persistent ownership was acquired. */ },
  };
  Object.defineProperty(store, previewStoreBrand, { value: true, enumerable: false });
  previewStores.add(store);
  return store as StewardshipPreviewStore;
}
