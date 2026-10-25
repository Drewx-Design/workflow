import { describe, expect, it } from "vitest";
import { createStewardshipPolicy, knownStewardshipPolicy, resolveStewardshipPolicy, validateStewardshipPolicyChange, validateStewardshipPolicyUpgrade, parseStewardshipPolicy, stewardshipPolicySha256, stewardshipOperationSchema, stewardshipOperationField, stewardshipOperationValue, stewardshipWritableFields, stewardshipPolicyUpgradePreservesAssessments, STEWARDSHIP_LIMITS } from "../lib/github-issue-roadmap/stewardship-policy";

describe("closed stewardship authority", () => {
  it("pins sanitized v1-v5 hashes without admitting unregistered tuning", () => {
    const v1 = knownStewardshipPolicy("v1", { repository: "example-org/example-repo", operator: "owner" });
    const v2 = knownStewardshipPolicy("v2", v1);
    expect(stewardshipPolicySha256(v1)).toBe("b00d12382ade1b7b4a6439e9ca2395a279d57a8b7b3b2a51ae02e25d202eb419");
    expect(stewardshipPolicySha256(v2)).toBe("34553caa74ce4cda0f19318800fb284f4b0b0154141f3ddbaa7fc2a86de7984f");
    expect(v1).toEqual(knownStewardshipPolicy("v1", v1));
    const v3 = knownStewardshipPolicy("v3", v1);
    expect(stewardshipPolicySha256(v3)).toBe("3fd7a1db5074cc8be43c1fd5597f6d8e72abc30a15daf010c0b54e25b8581a8f");
    expect(resolveStewardshipPolicy(stewardshipPolicySha256(v3), v1)).toEqual(v3);
    // v4 changes only the registered operational concurrency limit.
    const v4 = knownStewardshipPolicy("v4", v1);
    expect(stewardshipPolicySha256(v4)).toBe("cdd40451237d0a0c8ebf39880354ffcf0bc7a4fc0a6c416faf137a8dbd565e47");
    expect(v4.limits).toEqual({ ...v3.limits, issueConcurrency: 2 });
    expect(resolveStewardshipPolicy(stewardshipPolicySha256(v4), v1)).toEqual(v4);
    expect(() => validateStewardshipPolicyChange(v3, v4)).not.toThrow();
    // v5 changes only the registered operational run deadline.
    const production = knownStewardshipPolicy("v5", v1);
    expect(stewardshipPolicySha256(production)).toBe("dd883974b93d4211d7450e62bfe46c2382d01d863ba0a037e49ac9496e6c5153");
    expect(production).toEqual(knownStewardshipPolicy("v5", v1));
    expect(production.limits).toEqual({ ...v4.limits, runDurationMs: 10800000 });
    expect(production).toEqual({ ...v4, limits: { ...v4.limits, runDurationMs: 10800000 } });
    expect(resolveStewardshipPolicy(stewardshipPolicySha256(production), v1)).toEqual(production);
    expect(() => validateStewardshipPolicyChange(v4, production)).not.toThrow();
    expect(() => validateStewardshipPolicyChange(v3, production)).not.toThrow();
    expect(production.authority).toEqual(["set_horizon", "set_effort", "set_priority", "clear_priority", "set_lifecycle", "clear_lifecycle"]);
    expect(production.limits).toMatchObject({ hydratedIssues: 40, expandedIssues: 40, changedIssues: 1000, remoteMutations: 3000, issueConcurrency: 2 });
    expect(() => validateStewardshipPolicyChange(v2, production)).toThrow(/operational/);
    for (const issueConcurrency of [0, -1, 1.5, 3, "1"]) {
      expect(() => parseStewardshipPolicy({ ...production, limits: { ...production.limits, issueConcurrency } })).toThrow();
    }
    expect(v2.limits).toMatchObject({ assessmentTimeoutMs: 240000, assessmentTimeoutRetries: 1,
      assessmentAdmissionMs: 2100000, runDurationMs: 3300000, assessmentCalls: 32 });
    expect(resolveStewardshipPolicy(stewardshipPolicySha256(v2), v1)).toEqual(v2);
    expect(() => validateStewardshipPolicyChange(v1, v2)).not.toThrow();
    expect(() => validateStewardshipPolicyChange(v2, v1)).not.toThrow();
    expect(() => validateStewardshipPolicyChange(v1, { ...v2, operator: "someone-else" })).toThrow(/operational/i);
    expect(() => parseStewardshipPolicy({ ...v2, limits: { ...v2.limits, nowCapacity: 4 } })).toThrow();
    expect(() => parseStewardshipPolicy({ ...v2, limits: { ...v2.limits, assessmentTimeoutMs: 240001 } })).toThrow();
    expect(() => resolveStewardshipPolicy("f".repeat(64), v1)).toThrow(/unknown.*policy/i);
  });
  it("binds repository and operator with immutable operating limits", () => {
    const policy = createStewardshipPolicy({ repository: "example-org/example-repo", operator: "example-user" });
    expect(policy.repository).toBe("example-org/example-repo");
    // The v6 production default retains the full backlog's mutation budget.
    expect(policy.limits.remoteMutations).toBe(3000);
    expect(STEWARDSHIP_LIMITS.nowCapacity).toBe(3);
    expect(stewardshipPolicySha256(policy)).toBe(stewardshipPolicySha256(JSON.parse(JSON.stringify(policy, null, 4))));
    expect(() => parseStewardshipPolicy({ ...policy, permissions: ["close_issue"] })).toThrow();
    expect(() => parseStewardshipPolicy({ ...policy, limits: { ...policy.limits, remoteMutations: 26 } })).toThrow();
  });
  it("decodes historical operations plus Effort sets and Priority clears", () => {
    expect(stewardshipOperationSchema.parse({ kind: "set_priority", value: "P1" })).toEqual({ kind: "set_priority", value: "P1" });
    expect(stewardshipOperationSchema.parse({ kind: "clear_horizon" })).toEqual({ kind: "clear_horizon" });
    expect(stewardshipOperationSchema.parse({ kind: "clear_priority" })).toEqual({ kind: "clear_priority" });
    expect(stewardshipOperationSchema.parse({ kind: "set_effort", value: "Low" })).toEqual({ kind: "set_effort", value: "Low" });
    for (const operation of [{ kind: "set_priority", value: null }, { kind: "close_issue" }, { kind: "clear_horizon", value: "Now" }]) {
      expect(() => stewardshipOperationSchema.parse(operation)).toThrow();
    }
  });
  it("adopts v6 with v5 limits plus its cadence tuning and version-scoped Sort key authority", () => {
    const v5 = knownStewardshipPolicy("v5", { repository: "example-org/example-repo", operator: "owner" });
    const v6 = knownStewardshipPolicy("v6", v5);
    expect(createStewardshipPolicy(v5)).toEqual(v6);
    expect(v6.limits).toEqual({ ...v5.limits, assessmentTimeoutMs: 420000, continuationDelayMs: 5 * 60_000 });
    expect(stewardshipPolicyUpgradePreservesAssessments(v5, v6)).toBe(true);
    expect(v6.authority).toEqual([...v5.authority, "set_sort_key", "clear_sort_key"]);
    expect(resolveStewardshipPolicy(stewardshipPolicySha256(v6), v5)).toEqual(v6);
    for (const version of ["v1", "v2", "v3", "v4", "v5"] as const) {
      expect(stewardshipWritableFields(knownStewardshipPolicy(version, v5))).not.toContain("Sort key");
    }
    expect(stewardshipWritableFields(v6)).toEqual(["Priority", "Horizon", "Effort", "Lifecycle", "Sort key"]);
    expect(() => validateStewardshipPolicyChange(v5, v6)).toThrow(/operational/);
  });
  it("decodes only non-negative safe integer Sort key sets and valueless clears", () => {
    for (const value of [0, 9075, 5040000, Number.MAX_SAFE_INTEGER]) {
      const operation = stewardshipOperationSchema.parse({ kind: "set_sort_key", value });
      expect(stewardshipOperationField(operation)).toBe("Sort key");
      expect(stewardshipOperationValue(operation)).toBe(value);
    }
    const clear = stewardshipOperationSchema.parse({ kind: "clear_sort_key" });
    expect(stewardshipOperationField(clear)).toBe("Sort key");
    expect(stewardshipOperationValue(clear)).toBeNull();
    for (const value of [-1, 9075.0000001, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "9075", null]) {
      expect(() => stewardshipOperationSchema.parse({ kind: "set_sort_key", value })).toThrow();
    }
    expect(() => stewardshipOperationSchema.parse({ kind: "clear_sort_key", value: 0 })).toThrow();
  });
  it("accepts exactly the registered v2-to-v3 and v5-to-v6 authority transitions", () => {
    const identity = { repository: "example-org/example-repo", operator: "owner" };
    for (const from of ["v1", "v2", "v3", "v4", "v5", "v6"] as const) {
      for (const to of ["v1", "v2", "v3", "v4", "v5", "v6"] as const) {
        const validate = () => validateStewardshipPolicyUpgrade(knownStewardshipPolicy(from, identity), knownStewardshipPolicy(to, identity));
        if ((from === "v2" && to === "v3") || (from === "v5" && to === "v6")) expect(validate).not.toThrow();
        else expect(validate).toThrow(/registered/);
      }
    }
  });
});
