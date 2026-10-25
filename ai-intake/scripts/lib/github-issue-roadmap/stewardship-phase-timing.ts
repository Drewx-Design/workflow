/**
 * Phase durations are inclusive: send contains fence.observe.send and fence.local;
 * readback contains observe.total, which contains collect.* and observe.comments.
 * fence.observe aggregates fence.observe.preflight and fence.observe.send; both
 * contain observe.total. collect.gitSources does not nest inside collect.history:
 * local source reads run separately from the remote field-history reads.
 * p50Ms and p95Ms are approximate histogram upper bounds.
 */
import { performance } from "node:perf_hooks";

export const STEWARDSHIP_TIMING_PHASES = [
  "observe.total", "collect.census.sweep", "collect.hydration", "collect.history",
  "collect.gitSources", "collect.mainCompare", "observe.comments", "collect.retryWait",
  "transport.retryWait", "fence.observe", "fence.observe.preflight", "fence.observe.send",
  "fence.local", "send", "readback",
] as const;
type Phase = typeof STEWARDSHIP_TIMING_PHASES[number];
export interface StewardshipPhaseTimingEntry {
  count: number; totalMs: number; maxMs: number; p50Ms: number; p95Ms: number;
  /** True when all timed calls were synchronous; false if any call awaited. */
  sync: boolean;
  syncCount: number; asyncCount: number;
  retries?: number;
}
export type StewardshipPhaseTiming = Partial<Record<Phase, StewardshipPhaseTimingEntry>>;
export interface StewardshipRateLimit {
  minRemaining: number | null; lastRemaining: number | null; lastReset: number | null;
  limit: number | null; lastUsed: number | null;
  responses403: number; responses429: number; retryAfterResponses: number;
}
export type StewardshipRateLimits = Record<string, StewardshipRateLimit>;

// Closed keys prevent server-controlled strings from becoming recorded data or
// growing the side channel. Unrecognized or absent resource names use unknown.
const RESOURCES = new Set([
  "core", "graphql", "search", "code_search", "integration_manifest", "source_import",
  "actions_runner_registration", "scim", "dependency_snapshots", "code_scanning_upload",
  "code_scanning_autofix", "audit_log", "audit_log_streaming",
]);
const RATE_HEADERS = ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset",
  "x-ratelimit-resource", "x-ratelimit-used", "retry-after"] as const;
const BUCKETS = 256;
const LOG_STEP = Math.log(1.1);

/** Run-local telemetry only: never attach this collector to evidence or receipts. */
export class StewardshipTimingCollector {
  private readonly phases = new Map<Phase, { entry: StewardshipPhaseTimingEntry; histogram: number[] }>();
  private readonly resources: StewardshipRateLimits = {};
  constructor(private readonly clock: () => number = () => performance.now()) {}

  private phase(name: Phase) {
    let phase = this.phases.get(name);
    if (!phase) {
      phase = { entry: { count: 0, totalMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0, sync: true, syncCount: 0, asyncCount: 0 },
        histogram: Array<number>(BUCKETS).fill(0) };
      this.phases.set(name, phase);
    }
    return phase;
  }
  start(name: Phase, sync: boolean): () => void {
    const started = this.clock();
    return () => {
      const elapsed = this.clock() - started;
      const ms = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
      const { entry, histogram } = this.phase(name);
      entry.count++; entry.totalMs += ms; entry.maxMs = Math.max(entry.maxMs, ms);
      entry.sync &&= sync;
      if (sync) entry.syncCount++; else entry.asyncCount++;
      histogram[Math.min(BUCKETS - 1, Math.ceil(Math.log1p(ms) / LOG_STEP))]++;
    };
  }
  retry(name: "collect.retryWait" | "transport.retryWait" = "collect.retryWait"): void {
    const entry = this.phase(name).entry;
    entry.retries = (entry.retries ?? 0) + 1;
  }
  snapshot(): { phaseTiming: StewardshipPhaseTiming; rateLimits: StewardshipRateLimits } {
    const phaseTiming: StewardshipPhaseTiming = {};
    for (const [name, { entry, histogram }] of this.phases) {
      // Fixed logarithmic histogram: percentile upper bounds within 10% + 0.1ms
      // below the overflow bucket, clamped to the observed maximum.
      const percentile = (fraction: number) => {
        if (!entry.count) return 0;
        let count = 0;
        const target = Math.ceil(entry.count * fraction);
        for (let index = 0; index < histogram.length; index++) {
          count += histogram[index];
          if (count >= target) return index === BUCKETS - 1 ? entry.maxMs : Math.min(entry.maxMs, Math.expm1(index * LOG_STEP));
        }
        return entry.maxMs;
      };
      phaseTiming[name] = { ...entry, p50Ms: percentile(0.5), p95Ms: percentile(0.95) };
    }
    return { phaseTiming, rateLimits: structuredClone(this.resources) };
  }
  response(status: number | null, header: (name: string) => string | null): void {
    const rawResource = header("x-ratelimit-resource");
    const resource = rawResource !== null && RESOURCES.has(rawResource) ? rawResource : "unknown";
    const numeric = (name: string) => {
      const value = header(name);
      if (value === null || !/^\d+$/.test(value)) return null;
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : null;
    };
    const remaining = numeric("x-ratelimit-remaining");
    const reset = numeric("x-ratelimit-reset");
    const limit = numeric("x-ratelimit-limit");
    const used = numeric("x-ratelimit-used");
    const retryAfter = header("retry-after") !== null;
    if (remaining === null && reset === null && limit === null && used === null && !retryAfter && status !== 403 && status !== 429) return;
    const row = this.resources[resource] ??= { minRemaining: null, lastRemaining: null, lastReset: null,
      limit: null, lastUsed: null, responses403: 0, responses429: 0, retryAfterResponses: 0 };
    if (remaining !== null) { row.minRemaining = Math.min(row.minRemaining ?? remaining, remaining); row.lastRemaining = remaining; }
    if (reset !== null) row.lastReset = reset;
    if (limit !== null) row.limit = limit;
    if (used !== null) row.lastUsed = used;
    if (status === 403) row.responses403++;
    if (status === 429) row.responses429++;
    if (retryAfter) row.retryAfterResponses++;
  }
  includedResponse(raw: string): void {
    // Only a leading included header block is trusted. Never scan body text,
    // stderr, request arguments, URLs, or non-allowlisted header values.
    const lines = raw.split(/\r?\n/);
    const status = /^HTTP\/\d(?:\.\d)? (\d{3})\b/.exec(lines[0] ?? "");
    if (!status) return;
    const headers = new Map<string, string>();
    for (const line of lines.slice(1)) {
      const match = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
      if (!match) break;
      const name = match[1].toLowerCase();
      if (name === "retry-after") headers.set(name, "");
      else if ((RATE_HEADERS as readonly string[]).includes(name)) headers.set(name, match[2].trim());
    }
    this.response(Number(status[1]), (name) => headers.get(name) ?? null);
  }
}

function startTiming(timing: StewardshipTimingCollector | undefined, name: Phase, sync: boolean): () => void {
  let stop: (() => void) | undefined;
  try { stop = timing?.start(name, sync); } catch { /* Telemetry cannot affect the timed call. */ }
  return () => { try { stop?.(); } catch { /* Preserve the original result or error. */ } };
}

export function timeStewardshipSync<T>(timing: StewardshipTimingCollector | undefined, name: Phase, call: () => T): T {
  const stop = startTiming(timing, name, true);
  try { return call(); } finally { stop(); }
}
export function timeStewardshipAsync<T>(timing: StewardshipTimingCollector | undefined, name: Phase, call: () => Promise<T>): Promise<T> {
  if (!timing) return call();
  const stop = startTiming(timing, name, false);
  try { return call().finally(stop); } catch (error) { stop(); throw error; }
}

export function stewardshipTimingSummary({ phaseTiming, rateLimits }: ReturnType<StewardshipTimingCollector["snapshot"]>): string {
  const observe = phaseTiming["observe.total"];
  const census = phaseTiming["collect.census.sweep"];
  const parts = [observe ? `Observe p50 ${(observe.p50Ms / 1000).toFixed(1)}s` : "Observe count 0"];
  // Collect also runs outside observe, so do not claim a census/observe share.
  if (census) parts.push(`census sweeps ${(census.totalMs / 1000).toFixed(1)}s`);
  const quota = rateLimits.graphql ?? rateLimits.core;
  if (quota?.minRemaining !== null && quota?.minRemaining !== undefined) parts.push(`${rateLimits.graphql ? "graphql" : "core"} minRemaining ${quota.minRemaining}`);
  return `${parts.join("; ")}.`.slice(0, 199);
}
