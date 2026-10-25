import type { StewardshipRehearsalTransport } from "./stewardship-github";
import { executeStewardshipSnapshot, type StewardshipPreviewStore, type StewardshipRehearsalResult } from "./stewardship-executor";
import type { StewardshipTimingCollector, StewardshipRateLimits } from "./stewardship-phase-timing";
import type { StewardshipPolicy } from "./stewardship-policy";

interface RehearsalInput {
  reads: StewardshipRehearsalTransport;
  store: StewardshipPreviewStore;
  writeReport(name: string, bytes: string): string;
  policy: StewardshipPolicy;
  snapshotSha256: string;
  now(): string;
  sleep(milliseconds: number): Promise<void>;
  timing: StewardshipTimingCollector;
  budgetProbe(): Promise<{
    budget: StewardshipRateLimits;
    githubRequests: Record<"rest" | "graphql" | "other", { ok: number; error: number }>;
    githubRequestFailures: readonly unknown[];
    readonly githubRequestFailuresDropped: number;
  }>;
  liveRunProbe(): Promise<void>;
  options: { preflightConcurrency?: 1 | 2; injectTransient?: readonly ("preflight" | "fence" | "readback")[] };
}

/** Orchestration owns no factory, filesystem or durable-store acquisition capability. */
export async function runStewardshipRehearsal(input: RehearsalInput) {
  const { reads, store, policy, snapshotSha256, now, timing } = input;
  // Checked once at start. A live run starting mid-rehearsal is not detected, and its
  // own lock is unaffected. Operators must not start both at once. A crashed,
  // unfinished live run counts as active until reconciled; this fails closed.
  await input.liveRunProbe();
  if (Object.values(store.state.runs).some((run) => !run.resultSha256 && (run.mode === "run" || run.mode === undefined))) {
    throw new Error("rehearsal_live_run_active");
  }
  const started = performance.now();
  if (store.state.snapshots?.[snapshotSha256]?.status !== "approved") throw new Error("approved_snapshot_required");
  const runId = crypto.randomUUID();
  const initialSequence = store.state.sequence;
  store.append({ type: "run-started", runId, mode: "preview" }, now());
  const telemetry = await input.budgetProbe();
  const { budget, githubRequests, githubRequestFailures } = telemetry;
  // Last compile left 2536/5000 core REST. One rehearsal costs one live run's reads:
  // run at most one per reset window alongside a compile, and refuse below 1500.
  process.stderr.write(`Rehearsal budget: core REST ${budget.core?.lastRemaining ?? "unknown"}; GraphQL ${budget.graphql?.lastRemaining ?? "unknown"}.\n`);
  if ((budget.core?.lastRemaining ?? -1) < 1500) throw new Error("rehearsal_core_budget_below_1500");
  for (const [name, resource] of Object.entries(budget)) timing.response(200, (header) => new Map(Object.entries({
    "x-ratelimit-resource": name, "x-ratelimit-remaining": String(resource.lastRemaining), "x-ratelimit-limit": String(resource.limit),
    "x-ratelimit-reset": String(resource.lastReset), "x-ratelimit-used": String(resource.lastUsed),
  })).get(header) ?? null);
  let archiveCalls = 0;
  const archive = store.archive;
  store.archive = (value) => { archiveCalls++; return archive(value); };
  let result: StewardshipRehearsalResult;
  let aborted: { error: unknown; phase: string } | undefined;
  try {
    result = await executeStewardshipSnapshot({ policy, store, runId, snapshotSha256, now,
      sleep: input.sleep, phaseTiming: timing,
      rehearsal: { transport: reads, preflightConcurrency: input.options.preflightConcurrency ?? 1 } });
  } catch (error) {
    const partial = error as { rehearsalResult?: StewardshipRehearsalResult; phase?: string };
    if (!partial.rehearsalResult) throw error;
    result = { ...partial.rehearsalResult, ...timing.snapshot() };
    aborted = { error, phase: partial.phase ?? "unknown" };
  } finally { store.archive = archive; }
  const measuredWallMs = performance.now() - started;
  const modeledLiveWallMs = measuredWallMs + result.sendCount * policy.limits.mutationIntervalMs;
  const phases = Object.entries(result.phaseTiming).map(([phase, value]) => `${phase} p50=${value.p50Ms.toFixed(1)}ms p95=${value.p95Ms.toFixed(1)}ms`).join("; ");
  const remaining = (name: string) => `${name} ${result.rateLimitsStart[name]?.lastRemaining ?? "unknown"}->${result.rateLimits[name]?.lastRemaining ?? "unknown"}`;
  const summary = `Rehearsal measured wall=${(measuredWallMs / 1000).toFixed(1)}s; modeled live wall=${(modeledLiveWallMs / 1000).toFixed(1)}s; ${phases}; GitHub REST=${githubRequests.rest.ok + githubRequests.rest.error} GraphQL=${githubRequests.graphql.ok + githubRequests.graphql.error}; ${remaining("core")}; ${remaining("graphql")}.`;
  const report = { runId, mode: "rehearse", ...result,
    ...(aborted ? { aborted: "rate_limited", phase: aborted.phase } : {}),
    notes: { durableFileWrites: "excluded", excludedDurableFileWriteCount: archiveCalls + store.state.sequence - initialSequence },
    snapshotPlan: result.summary, startedAt: store.state.runs[runId].startedAt, finishedAt: now(),
    measuredWallMs, modeledLiveWallMs, githubRequests, githubRequestFailures,
    githubRequestFailuresDropped: telemetry.githubRequestFailuresDropped, summary };
  const reportPath = input.writeReport(`rehearsal-${runId}.json`, `${JSON.stringify(report, null, 2)}\n`);
  if (aborted) { process.stderr.write(`${summary} Partial report: ${reportPath}\n`); throw aborted.error; }
  return { ...report, reportPath };
}
