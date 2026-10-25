import { z } from "zod";
import { canonicalJsonSha256 } from "./canonical-json";

export const STEWARDSHIP_LIMITS = Object.freeze({
  nowCapacity: 3, hydratedIssues: 12, nowSlots: 8, nonNowSlots: 4,
  initialEvidenceBytes: 96 * 1024, expansionEvidenceBytes: 96 * 1024, expandedIssues: 4,
  assessmentCalls: 32, assessmentTimeoutMs: 180_000,
  runDurationMs: 30 * 60_000, assessmentAdmissionMs: 20 * 60_000,
  changedIssues: 10, remoteMutations: 25, mutationIntervalMs: 1000,
  readAttempts: 3, mixedCaptureRetries: 2, executionBindingMs: 5 * 60_000,
  continuationDelayMs: 60 * 60_000,
});

export const stewardshipHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const stewardshipPrioritySchema = z.enum(["P0", "P1", "P2", "P3"]);
export const stewardshipHorizonSchema = z.enum(["Now", "Next", "Later", "Parked"]);
export type Priority = z.infer<typeof stewardshipPrioritySchema>;
export type Horizon = z.infer<typeof stewardshipHorizonSchema>;
export const STEWARDSHIP_NATIVE_FIELDS = ["Priority", "Horizon", "Effort", "Lifecycle"] as const;
export const stewardshipLifecycleSchema = z.enum(["Done candidate", "Stale candidate"]);
export const stewardshipSortKeySchema = z.number().int().nonnegative().safe();
export type StewardshipNativeField = typeof STEWARDSHIP_NATIVE_FIELDS[number] | "Sort key";
export const stewardshipOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set_priority"), value: stewardshipPrioritySchema }).strict(),
  z.object({ kind: z.literal("set_horizon"), value: stewardshipHorizonSchema }).strict(),
  z.object({ kind: z.literal("set_effort"), value: z.enum(["Low", "Medium", "High"]) }).strict(),
  z.object({ kind: z.literal("clear_priority") }).strict(),
  z.object({ kind: z.literal("clear_horizon") }).strict(),
  z.object({ kind: z.literal("set_lifecycle"), value: stewardshipLifecycleSchema }).strict(),
  z.object({ kind: z.literal("clear_lifecycle") }).strict(),
  z.object({ kind: z.literal("set_sort_key"), value: stewardshipSortKeySchema }).strict(),
  z.object({ kind: z.literal("clear_sort_key") }).strict(),
  // The execution compiler validates the narrowly formatted body before archival.
  z.object({ kind: z.literal("append_comment"), purpose: z.enum(["verification", "decision"]), bodySha256: stewardshipHashSchema }).strict(),
]);
export type StewardshipOperation = z.infer<typeof stewardshipOperationSchema>;
const OPERATION_FIELDS = { set_priority: "Priority", clear_priority: "Priority", set_horizon: "Horizon", clear_horizon: "Horizon", set_effort: "Effort", set_lifecycle: "Lifecycle", clear_lifecycle: "Lifecycle", set_sort_key: "Sort key", clear_sort_key: "Sort key" } as const;
export function stewardshipOperationField(operation: StewardshipOperation): StewardshipNativeField | null {
  return operation.kind === "append_comment" ? null : OPERATION_FIELDS[operation.kind];
}
export function stewardshipOperationValue(operation: StewardshipOperation): string | number | null {
  return "value" in operation ? operation.value : null;
}

const repositorySchema = z.string().regex(/^[-a-z0-9_.]+\/[-a-z0-9_.]+$/);
// Registry versions name exact operating literals; the artifact format remains v1.
const POLICY_LIMITS = Object.freeze({
  v1: STEWARDSHIP_LIMITS,
  v2: Object.freeze({ ...STEWARDSHIP_LIMITS, assessmentTimeoutMs: 240000, assessmentTimeoutRetries: 1,
    assessmentAdmissionMs: 2100000, runDurationMs: 3300000 }),
  v3: Object.freeze({ ...STEWARDSHIP_LIMITS, nowCapacity: 8, hydratedIssues: 40, expandedIssues: 40,
    assessmentCalls: 320, changedIssues: 1000, remoteMutations: 3000, issueConcurrency: 1,
    assessmentTimeoutMs: 240000, assessmentTimeoutRetries: 1, assessmentAdmissionMs: 2100000, runDurationMs: 3300000 }),
  v4: Object.freeze({ ...STEWARDSHIP_LIMITS, nowCapacity: 8, hydratedIssues: 40, expandedIssues: 40,
    assessmentCalls: 320, changedIssues: 1000, remoteMutations: 3000, issueConcurrency: 2,
    assessmentTimeoutMs: 240000, assessmentTimeoutRetries: 1, assessmentAdmissionMs: 2100000, runDurationMs: 3300000 }),
  v5: Object.freeze({ ...STEWARDSHIP_LIMITS, nowCapacity: 8, hydratedIssues: 40, expandedIssues: 40,
    assessmentCalls: 320, changedIssues: 1000, remoteMutations: 3000, issueConcurrency: 2,
    assessmentTimeoutMs: 240000, assessmentTimeoutRetries: 1, assessmentAdmissionMs: 2100000, runDurationMs: 10800000 }),
  // v6 has no adoption yet: GLM calls ran 190-245 s, and a 5 min delay lets the hourly trigger take the next slice.
  v6: Object.freeze({ ...STEWARDSHIP_LIMITS, nowCapacity: 8, hydratedIssues: 40, expandedIssues: 40,
    assessmentCalls: 320, changedIssues: 1000, remoteMutations: 3000, issueConcurrency: 2,
    assessmentTimeoutMs: 420000, assessmentTimeoutRetries: 1, assessmentAdmissionMs: 2100000, runDurationMs: 10800000,
    continuationDelayMs: 5 * 60_000 }),
});
const PRODUCTION_POLICY_VERSION = "v6";
export const PRODUCTION_STEWARDSHIP_LIMITS = POLICY_LIMITS[PRODUCTION_POLICY_VERSION];
type RegisteredLimits = typeof POLICY_LIMITS[keyof typeof POLICY_LIMITS];
const registeredLimitsSchema = z.custom<RegisteredLimits>((value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(POLICY_LIMITS).some((limits) => Object.keys(value).length === Object.keys(limits).length
    && Object.entries(limits).every(([key, expected]) => Object.hasOwn(value, key) && (value as Record<string, unknown>)[key] === expected));
}, "Unknown stewardship policy limits").transform((limits) => Object.freeze({ ...limits }));
export const stewardshipPolicySchema = z.object({
  schemaVersion: z.literal("github-issue-roadmap-stewardship-policy/v1"),
  repository: repositorySchema,
  operator: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/),
  rubric: z.literal("roadmap-priority-horizon/v1"),
  authority: z.union([
    z.tuple([z.literal("set_priority"), z.literal("set_horizon"), z.literal("clear_horizon"), z.literal("append_comment")]),
    z.tuple([z.literal("set_horizon"), z.literal("set_effort"), z.literal("set_priority"), z.literal("clear_priority"), z.literal("set_lifecycle"), z.literal("clear_lifecycle")]),
    z.tuple([z.literal("set_horizon"), z.literal("set_effort"), z.literal("set_priority"), z.literal("clear_priority"), z.literal("set_lifecycle"), z.literal("clear_lifecycle"), z.literal("set_sort_key"), z.literal("clear_sort_key")]),
  ]),
  limits: registeredLimitsSchema,
}).strict().refine((policy) => ("issueConcurrency" in policy.limits) === policy.authority.some((kind) => kind === "set_effort"), "Authority must match registered policy limits");
export type StewardshipPolicy = z.infer<typeof stewardshipPolicySchema>;

export function knownStewardshipPolicy(version: keyof typeof POLICY_LIMITS, input: { repository: string; operator: string }): StewardshipPolicy {
  return stewardshipPolicySchema.parse({
    schemaVersion: "github-issue-roadmap-stewardship-policy/v1", repository: input.repository.toLowerCase(),
    operator: input.operator, rubric: "roadmap-priority-horizon/v1",
    // 2026-10-06: v3 had no adoption when Lifecycle authority was extended in place.
    authority: version === "v6" ? ["set_horizon", "set_effort", "set_priority", "clear_priority", "set_lifecycle", "clear_lifecycle", "set_sort_key", "clear_sort_key"]
      : version === "v3" || version === "v4" || version === "v5" ? ["set_horizon", "set_effort", "set_priority", "clear_priority", "set_lifecycle", "clear_lifecycle"] : ["set_priority", "set_horizon", "clear_horizon", "append_comment"], limits: POLICY_LIMITS[version],
  });
}

/** Resolve historical bindings only within the same repository and operator registry. */
export function resolveStewardshipPolicy(sha256: string, identity: { repository: string; operator: string }): StewardshipPolicy {
  for (const version of Object.keys(POLICY_LIMITS) as (keyof typeof POLICY_LIMITS)[]) {
    const policy = knownStewardshipPolicy(version, identity);
    if (stewardshipPolicySha256(policy) === sha256) return policy;
  }
  throw new Error(`Unknown stewardship policy ${sha256}; code must know every journal policy epoch`);
}

export function validateStewardshipPolicyChange(previous: unknown, next: unknown): void {
  const operational = new Set(["assessmentTimeoutMs", "assessmentTimeoutRetries", "assessmentAdmissionMs", "runDurationMs", "assessmentCalls", "issueConcurrency"]);
  const fixed = (value: StewardshipPolicy) => ({ ...value,
    limits: Object.fromEntries(Object.entries(value.limits).filter(([name]) => !operational.has(name))) });
  if (canonicalJsonSha256(fixed(parseStewardshipPolicy(previous))) !== canonicalJsonSha256(fixed(parseStewardshipPolicy(next)))) {
    throw new Error("Policy change must be confined to operational tuning fields");
  }
}

export function isSnapshotStewardshipPolicy(policy: StewardshipPolicy): boolean {
  return policy.authority.some((kind) => kind === "set_effort");
}
export function stewardshipWritableFields(policy: StewardshipPolicy): readonly StewardshipNativeField[] {
  return ([...STEWARDSHIP_NATIVE_FIELDS, "Sort key"] as const).filter((field) =>
    policy.authority.some((kind) => kind !== "append_comment" && OPERATION_FIELDS[kind] === field));
}
export function stewardshipPolicyUpgradePreservesAssessments(previous: unknown, next: unknown): boolean {
  const before = parseStewardshipPolicy(previous); const after = parseStewardshipPolicy(next);
  return stewardshipPolicySha256(before) === stewardshipPolicySha256(knownStewardshipPolicy("v5", before))
    && stewardshipPolicySha256(after) === stewardshipPolicySha256(knownStewardshipPolicy("v6", before));
}
export function validateStewardshipPolicyUpgrade(previous: unknown, next: unknown): void {
  const before = parseStewardshipPolicy(previous); const after = parseStewardshipPolicy(next);
  if (!stewardshipPolicyUpgradePreservesAssessments(before, after)
    && (stewardshipPolicySha256(before) !== stewardshipPolicySha256(knownStewardshipPolicy("v2", before))
    || stewardshipPolicySha256(after) !== stewardshipPolicySha256(knownStewardshipPolicy("v3", before)))) {
    throw new Error("policy-upgrade permits only the registered v2 -> v3 and v5 -> v6 transitions");
  }
}

/** Registry entries from v2 onward admit per issue and allow timeout retries. */
export function stewardshipTimeoutRetries(policy: StewardshipPolicy): number {
  return "assessmentTimeoutRetries" in policy.limits ? policy.limits.assessmentTimeoutRetries : 0;
}

export function createStewardshipPolicy(input: { repository: string; operator: string }): StewardshipPolicy {
  return knownStewardshipPolicy(PRODUCTION_POLICY_VERSION, input);
}
export function parseStewardshipPolicy(value: unknown): StewardshipPolicy { return stewardshipPolicySchema.parse(value); }
export function stewardshipPolicySha256(value: unknown): string { return canonicalJsonSha256(parseStewardshipPolicy(value)); }
