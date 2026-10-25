/** Pure B11/B12 contract. Event descriptors specify order, not journal payloads. */
export type StewardshipSnapshotOpState = "P" | "S" | "A" | "C" | "N" | "R" | "unresolved" | "conflict";

export type StewardshipSnapshotCondition =
  | { point: "rehearsal"; condition: "rehearsed" }
  | { point: "before-classification"; condition: "invalid-basis" | "deadline" }
  | { point: "classification"; condition: "read-recovered" | "target-drift-or-absence" | "target-unavailable" | "mixed-generation-exhausted" | "snapshot-failure" | "deadline" }
  | { point: "classification-complete"; condition: "threshold-exceeded" | "infeasible-schedule" }
  | { point: "classification-complete"; condition: "feasible";
    /** The current op's issue; nextState changes only for a pending op on a skipped issue. */
    issueNumber: number;
    issueOrder: readonly number[];
    skippedIssueNumbers: readonly number[] }
  | { point: "before-attempt"; condition: "target-fence-failed" | "target-unavailable" | "deadline" | "global-failure" }
  | { point: "attempt"; condition: "admitted" }
  | { point: "after-attempt"; condition: "definite-rejection" | "sent-false" | "lock-lost" | "verified" | "incomplete-readback" | "incompatible-drift" | "deadline" }
  | { point: "after-attempt"; condition: "unchanged"; completeReadback: boolean; bindingWindowElapsed: boolean }
  | { point: "after-confirmation"; condition: "deadline-with-work" }
  | { point: "completion"; condition: "all-confirmed" | "with-skips" };

export type StewardshipSnapshotTransitionEvent =
  | { type: "action-attempted" | "snapshot-plan" | "snapshot-completed" | "run-finished" }
  // Classification skips identify their issue; the immediate send-fence row is unchanged.
  | { type: "snapshot-issue-skip"; issueNumber?: number }
  | { type: "action-outcome"; outcome: "confirmed" | "not-applied" | "unresolved" | "conflict" }
  | { type: "snapshot-refused"; reason: "failure" | "threshold-exceeded" | "completed-with-skips" };
export type StewardshipSnapshotApprovalEffect = "none" | "retain" | "inhibit" | "replacement-required" | "completed";
export type StewardshipSnapshotRunResult = "refused" | "partial" | "continue-classification" | "enter-sends"
  | "continue-independent-work" | "perform-transport-attempt" | "continue" | "stop" | "success" | "completed-with-skips";
export type StewardshipSnapshotTransitionInput = StewardshipSnapshotCondition & {
  state: StewardshipSnapshotOpState;
  journalUsable: boolean;
  lockValid: boolean;
};
export interface StewardshipSnapshotTransition {
  nextState: StewardshipSnapshotOpState;
  events: StewardshipSnapshotTransitionEvent[];
  approvalEffect: StewardshipSnapshotApprovalEffect;
  runResult: StewardshipSnapshotRunResult;
}

/** Terminal states may be retained by run-level rows, but never reclassified. */
export function classifyStewardshipSnapshotTransition(input: StewardshipSnapshotTransitionInput): StewardshipSnapshotTransition {
  const { state, point, condition } = input;
  const finish: StewardshipSnapshotTransitionEvent = { type: "run-finished" };
  const refusal: StewardshipSnapshotTransitionEvent = { type: "snapshot-refused", reason: "failure" };
  const result = (allowed: readonly StewardshipSnapshotOpState[], nextState: StewardshipSnapshotOpState,
    events: StewardshipSnapshotTransitionEvent[], approvalEffect: StewardshipSnapshotApprovalEffect,
    runResult: StewardshipSnapshotRunResult): StewardshipSnapshotTransition => {
    if (!allowed.includes(state)) throw new Error(`Illegal snapshot transition: ${state} at ${point}/${condition}`);
    // Lock loss leaves only the attempted record. Recovery journals uncertainty
    // and retires the approval; this invocation cannot journal any effect.
    if (point === "after-attempt" && condition === "lock-lost") return {
      nextState: state, events: [], approvalEffect: "none", runResult: "stop",
    };
    // No durable state can advance without the journal and lock, even on a stop path.
    if (!input.journalUsable || !input.lockValid) return { nextState: state, events: [], approvalEffect: "inhibit",
      runResult: point === "before-classification" && condition === "invalid-basis" ? "refused" : "stop" };
    return { nextState, events, approvalEffect, runResult };
  };
  const all: StewardshipSnapshotOpState[] = ["P", "S", "A", "C", "N", "R", "unresolved", "conflict"];
  const candidates: StewardshipSnapshotOpState[] = ["P", "S", "C", "N"];
  switch (input.point) {
    case "rehearsal": return result(["P"], "R", [], "none", "continue");
    case "before-classification":
      return input.condition === "invalid-basis"
        ? result(all, state, [refusal], "inhibit", "refused")
        : result(candidates, state, [finish], "retain", "partial");
    case "classification":
      switch (input.condition) {
        case "read-recovered": return result(["P"], "P", [], "none", "continue-classification");
        case "target-drift-or-absence": return result(["P"], "P", [], "none", "continue-classification");
        case "target-unavailable":
        case "mixed-generation-exhausted": return result(["P"], "P", [finish], "retain", "partial");
        case "snapshot-failure": return result(all, state, [refusal, finish], "replacement-required", "refused");
        case "deadline": return result(candidates, state, [finish], "retain", "partial");
      }
      break;
    case "classification-complete": {
      if (input.condition === "infeasible-schedule") return result(candidates, state, [refusal, finish], "replacement-required", "refused");
      if (input.condition === "threshold-exceeded") return result(candidates, state,
        [{ type: "snapshot-plan" }, { type: "snapshot-refused", reason: "threshold-exceeded" }, finish], "replacement-required", "refused");
      // Both refusal conditions returned above, so only the feasible variant remains.
      const feasible = input as Extract<typeof input, { condition: "feasible" }>;
      const skippedIssues = new Set(feasible.skippedIssueNumbers);
      if (new Set(feasible.issueOrder).size !== feasible.issueOrder.length || !feasible.issueOrder.includes(feasible.issueNumber)
        || [...skippedIssues].some((issue) => !feasible.issueOrder.includes(issue))) throw new Error("Invalid classification issue order");
      // These descriptors are one run-level sequence, not a sequence to append
      // once per op. All issue skips follow the complete plan before any send.
      return result(candidates, state === "P" && skippedIssues.has(feasible.issueNumber) ? "S" : state,
        [{ type: "snapshot-plan" }, ...feasible.issueOrder.filter((issue) => skippedIssues.has(issue))
          .map((issueNumber): StewardshipSnapshotTransitionEvent => ({ type: "snapshot-issue-skip", issueNumber }))], "retain", "enter-sends");
    }
    case "before-attempt":
      switch (input.condition) {
        // Established target drift or a skipped prerequisite, never unavailable evidence.
        case "target-fence-failed": return result(["P"], "S", [{ type: "snapshot-issue-skip" }], "retain", "continue-independent-work");
        // Fence unavailable after its single unstable retry, or transient transport failure before admission with no attempt recorded.
        case "target-unavailable": return result(candidates, state, [finish], "retain", "partial");
        case "deadline": return result(candidates, state, [finish], "retain", "partial");
        case "global-failure": return result(all, state, [refusal, finish], "replacement-required", "stop");
      }
      break;
    case "attempt": return result(["P"], "A", [{ type: "action-attempted" }], "retain", "perform-transport-attempt");
    case "after-attempt": {
      if (input.condition === "lock-lost") return result(["A"], "A", [], "none", "stop");
      if (input.condition === "sent-false") return result(["A"], "N", [{ type: "action-outcome", outcome: "not-applied" }], "retain", "continue-independent-work");
      if (input.condition === "verified") return result(["A"], "C", [{ type: "action-outcome", outcome: "confirmed" }], "retain", "continue");
      const outcome = input.condition === "definite-rejection"
        || (input.condition === "unchanged" && input.completeReadback && input.bindingWindowElapsed) ? "not-applied"
        : input.condition === "incompatible-drift" ? "conflict" : "unresolved";
      return result(["A"], outcome === "not-applied" ? "N" : outcome,
        [{ type: "action-outcome", outcome }, refusal, finish], "replacement-required", "stop");
    }
    case "after-confirmation":
      // The valid confirmation must be durable before the deadline finish record.
      return result(["C"], "C", [finish], "retain", "partial");
    case "completion":
      return input.condition === "all-confirmed"
        ? result(["C"], "C", [{ type: "snapshot-completed" }, finish], "completed", "success")
        : result(["C", "S", "N"], state, [{ type: "snapshot-refused", reason: "completed-with-skips" }, finish], "replacement-required", "completed-with-skips");
  }
  throw new Error("Unknown snapshot transition");
}

export interface StewardshipSnapshotApprovedOp {
  index: number;
  issueNumber: number;
  dependencyIndices: readonly number[];
  /** Omitted for a fresh approval. Include replayed states on continuation. */
  state?: StewardshipSnapshotOpState;
}
export type StewardshipSnapshotClassification = { index: number } & (
  // A skip here is direct drift or absence, never unavailable evidence.
  | { disposition: "send" } | { disposition: "skip"; reason: string }
  | { disposition: "outage"; reason: "target-unavailable" | "mixed-generation-exhausted" }
);
export type StewardshipSnapshotScheduleError =
  | { kind: "unresolved-prerequisite"; index: number }
  | { kind: "missing-dependency"; index: number; dependencyIndex: number }
  | { kind: "dependency-cycle" | "issue-dependency-cycle" }
  | { kind: "canonical-order-conflict"; index: number; dependencyIndex: number };
export interface StewardshipSnapshotClassificationPlan {
  skipped: { index: number; reasons: string[] }[];
  /** Direct drift/absence only; this is the set carried across continuations. */
  classificationSkippedIndices: number[];
  propagatedSkippedIndices: number[];
  /** Remaining outages require a partial stop unless a static schedule error refuses. */
  outageIndices: number[];
  partialStop: boolean;
  /** Topological issue-group order; empty when the schedule is invalid or the approval is empty. */
  issueOrder: number[];
  thresholdNumerator: number;
  thresholdDenominator: number;
  scheduleErrors: StewardshipSnapshotScheduleError[];
  refuse: boolean;
}

function hasCycle(dependencies: ReadonlyMap<number, readonly number[]>): boolean {
  const visited = new Set<number>();
  const visiting = new Set<number>();
  const visit = (index: number): boolean => {
    if (visiting.has(index)) return true;
    if (visited.has(index)) return false;
    visiting.add(index);
    for (const dependency of dependencies.get(index) ?? []) {
      if (dependencies.has(dependency) && visit(dependency)) return true;
    }
    visiting.delete(index); visited.add(index);
    return false;
  };
  return [...dependencies.keys()].some(visit);
}

/**
 * Only direct classification drift/absence skips enter the numerator.
 * Unit 5 may enter sends only when refuse === false && partialStop === false.
 * It must execute issue groups in exactly issueOrder, with each group's ops in
 * canonical index order. Ready-group ties use the smallest canonical op index.
 * issueOrder lists every issue group, including groups whose ops are all skipped
 * or N. Unit 5 no-ops any group with no sendable ops.
 */
export function planStewardshipSnapshotClassification(input: {
  approvedOps: readonly StewardshipSnapshotApprovedOp[];
  approvedOpCount: number;
  classifications: readonly StewardshipSnapshotClassification[];
  /** Carried direct skip indices only, excluding propagated and send-phase skips. */
  classificationSkippedIndices: ReadonlySet<number>;
}): StewardshipSnapshotClassificationPlan {
  if (input.approvedOps.length !== input.approvedOpCount) throw new Error("Approved operation count mismatch");
  const ops = [...input.approvedOps].sort((a, b) => a.index - b.index);
  const byIndex = new Map(ops.map((op) => [op.index, op]));
  if (byIndex.size !== ops.length || ops.some((op) => !Number.isSafeInteger(op.index) || op.index < 0
    || !Number.isSafeInteger(op.issueNumber) || op.issueNumber <= 0)) throw new Error("Invalid approved operation identity");
  const stateOf = (op: StewardshipSnapshotApprovedOp) => op.state ?? "P";
  const skips = new Map<number, Set<string>>();
  const classificationSkips = new Set<number>();
  const propagatedSkips = new Set<number>();
  const outages = new Set<number>();
  const add = (index: number, reason: string) => {
    const reasons = skips.get(index) ?? new Set<string>();
    reasons.add(reason); skips.set(index, reasons);
  };
  for (const index of input.classificationSkippedIndices) {
    const op = byIndex.get(index);
    if (!op || !["P", "S"].includes(stateOf(op))) throw new Error(`Invalid carried classification skip: ${index}`);
    add(index, `Carried classification skip for op ${index}`);
    classificationSkips.add(index);
  }
  for (const op of ops) {
    if (stateOf(op) === "S" && !classificationSkips.has(op.index)) add(op.index, `Recorded skip for op ${op.index}`);
  }
  const classified = new Set<number>();
  for (const classification of input.classifications) {
    const op = byIndex.get(classification.index);
    if (!op || classified.has(op.index) || stateOf(op) !== "P") throw new Error(`Invalid classification: ${classification.index}`);
    classified.add(op.index);
    if (classification.disposition === "skip") {
      if (!classification.reason.trim()) throw new Error(`Missing skip reason: ${op.index}`);
      add(op.index, classification.reason);
      classificationSkips.add(op.index);
    }
    if (classification.disposition === "outage") {
      if (skips.has(op.index)) throw new Error(`Cannot reclassify a carried skip as an outage: ${op.index}`);
      outages.add(op.index);
    }
  }
  for (const op of ops) {
    if (stateOf(op) === "P" && !classified.has(op.index) && !skips.has(op.index)) throw new Error(`Missing classification: ${op.index}`);
  }

  const scheduleErrors: StewardshipSnapshotScheduleError[] = [];
  const issueDependencies = new Map<number, number[]>();
  for (const op of ops) issueDependencies.set(op.issueNumber, []);
  for (const op of ops) {
    if (["A", "unresolved", "conflict"].includes(stateOf(op))) scheduleErrors.push({ kind: "unresolved-prerequisite", index: op.index });
    for (const dependencyIndex of op.dependencyIndices) {
      const dependency = byIndex.get(dependencyIndex);
      if (!dependency) scheduleErrors.push({ kind: "missing-dependency", index: op.index, dependencyIndex });
      else if (dependency.issueNumber !== op.issueNumber) issueDependencies.get(op.issueNumber)!.push(dependency.issueNumber);
      else if (dependency.index > op.index) scheduleErrors.push({ kind: "canonical-order-conflict", index: op.index, dependencyIndex });
    }
  }
  if (hasCycle(new Map(ops.map((op) => [op.index, op.dependencyIndices])))) scheduleErrors.push({ kind: "dependency-cycle" });
  // Consecutive issue groups can be impossible even when the individual op graph is acyclic.
  if (hasCycle(issueDependencies)) scheduleErrors.push({ kind: "issue-dependency-cycle" });

  const issueOrder: number[] = [];
  if (scheduleErrors.length === 0) {
    // Map insertion order follows each group's first op in the sorted approval.
    const remaining = new Set(issueDependencies.keys());
    const ordered = new Set<number>();
    while (remaining.size) {
      const next = [...remaining].find((issue) => issueDependencies.get(issue)!.every((dependency) => ordered.has(dependency)));
      if (next === undefined) {
        scheduleErrors.push({ kind: "issue-dependency-cycle" });
        issueOrder.length = 0;
        break;
      }
      issueOrder.push(next); ordered.add(next); remaining.delete(next);
    }
  }

  // Reconstruct classification propagation through recorded S states as well as
  // pending ops, without adding those indices to the carried direct set.
  const classificationReach = new Set(classificationSkips);
  let changed = true;
  while (changed) {
    changed = false;
    for (const op of ops) {
      if (!["P", "S"].includes(stateOf(op))) continue;
      const causes = ops.filter((other) => other.index !== op.index && other.issueNumber === op.issueNumber
        && (skips.has(other.index) || stateOf(other) === "N"))
        .map((other) => ({ index: other.index,
          reason: `Same issue ${op.issueNumber}: op ${other.index} ${stateOf(other) === "N" ? "was not applied" : "was skipped"}` }));
      for (const index of op.dependencyIndices) {
        if (skips.has(index)) causes.push({ index, reason: `Dependency op ${index} was skipped` });
        else if (byIndex.get(index)?.state === "N") causes.push({ index, reason: `Dependency op ${index} was not applied` });
      }
      // Both issue atomicity and an unavailable prerequisite override an outage.
      // An outage with no skip or N cause stays pending.
      if (outages.has(op.index)) {
        if (causes.length === 0) continue;
        outages.delete(op.index); changed = true;
      }
      for (const cause of causes) {
        if (stateOf(op) === "P") {
          if (!skips.has(op.index)) changed = true;
          add(op.index, cause.reason);
          if (!classificationSkips.has(op.index)) propagatedSkips.add(op.index);
        }
        if (classificationReach.has(cause.index)) {
          if (!classificationReach.has(op.index)) { classificationReach.add(op.index); changed = true; }
          add(op.index, cause.reason);
          if (!classificationSkips.has(op.index)) propagatedSkips.add(op.index);
        }
      }
    }
  }
  const partialStop = outages.size > 0;
  return {
    skipped: [...skips].sort(([a], [b]) => a - b).map(([index, reasons]) => ({ index, reasons: [...reasons].sort() })),
    classificationSkippedIndices: [...classificationSkips].sort((a, b) => a - b),
    propagatedSkippedIndices: [...propagatedSkips].sort((a, b) => a - b),
    outageIndices: [...outages].sort((a, b) => a - b),
    partialStop,
    issueOrder,
    thresholdNumerator: classificationSkips.size,
    thresholdDenominator: input.approvedOpCount,
    scheduleErrors,
    refuse: scheduleErrors.length > 0 || (!partialStop && 4 * classificationSkips.size > input.approvedOpCount),
  };
}
