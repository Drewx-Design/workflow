import { describe, expect, it, vi } from "vitest";
import { createStewardshipGitHub } from "../lib/github-issue-roadmap/stewardship-github";
import { STEWARDSHIP_TIMING_PHASES, StewardshipTimingCollector, stewardshipTimingSummary,
  timeStewardshipAsync, timeStewardshipSync } from "../lib/github-issue-roadmap/stewardship-phase-timing";
import { evidenceFixture, now, policy } from "./fixtures/roadmap-stewardship";

describe("run-scoped stewardship timing", () => {
  it("aggregates deterministic durations, failures, percentiles and sync/async waits", async () => {
    let clock = 0;
    const timing = new StewardshipTimingCollector(() => clock);
    for (let ms = 1; ms <= 100; ms++) timeStewardshipSync(timing, "collect.hydration", () => { clock += ms; });
    expect(() => timeStewardshipSync(timing, "fence.local", () => { clock += 7; throw new Error("refused"); })).toThrow("refused");
    await expect(timeStewardshipAsync(timing, "observe.total", async () => { clock += 11; throw new Error("deadline"); })).rejects.toThrow("deadline");
    timing.retry(); timeStewardshipSync(timing, "collect.retryWait", () => { clock += 12; });
    timing.retry(); await timeStewardshipAsync(timing, "collect.retryWait", async () => { clock += 20; });
    timing.retry("transport.retryWait"); await timeStewardshipAsync(timing, "transport.retryWait", async () => { clock += 30; });
    const { phaseTiming } = timing.snapshot();
    expect(phaseTiming["collect.hydration"]).toMatchObject({ count: 100, totalMs: 5050, maxMs: 100, sync: true });
    expect(phaseTiming["collect.hydration"]!.p50Ms).toBeGreaterThanOrEqual(50);
    expect(phaseTiming["collect.hydration"]!.p50Ms).toBeLessThanOrEqual(55.1);
    expect(phaseTiming["collect.hydration"]!.p95Ms).toBeGreaterThanOrEqual(95);
    expect(phaseTiming["fence.local"]).toMatchObject({ count: 1, totalMs: 7 });
    expect(phaseTiming["observe.total"]).toMatchObject({ count: 1, totalMs: 11, sync: false });
    expect(phaseTiming["collect.retryWait"]).toMatchObject({ count: 2, retries: 2, totalMs: 32, sync: false, syncCount: 1, asyncCount: 1 });
    expect(phaseTiming["transport.retryWait"]).toMatchObject({ count: 1, retries: 1, totalMs: 30, sync: false });
    expect(stewardshipTimingSummary(timing.snapshot()).length).toBeLessThan(200);
  });

  it.each(["start", "stop"])("drops %s exceptions while preserving exact sync and async results and errors", async (hook) => {
    const timing = new StewardshipTimingCollector();
    const fail = () => { throw new Error("telemetry failure"); };
    const start = vi.spyOn(timing, "start").mockImplementation(hook === "start" ? fail : () => fail);
    const value = {}; const error = new Error("original failure"); let calls = 0;
    expect(timeStewardshipSync(timing, "fence.local", () => { calls++; return value; })).toBe(value);
    expect(() => timeStewardshipSync(timing, "fence.local", () => { calls++; throw error; })).toThrow(error);
    await expect(timeStewardshipAsync(timing, "observe.total", async () => { calls++; return value; })).resolves.toBe(value);
    await expect(timeStewardshipAsync(timing, "observe.total", async () => { calls++; throw error; })).rejects.toBe(error);
    expect(() => timeStewardshipAsync(timing, "observe.total", () => { calls++; throw error; })).toThrow(error);
    expect(calls).toBe(5); expect(start).toHaveBeenCalledTimes(5);
  });

  it("records only allowlisted header telemetry, including secondary limits and failed gh output", () => {
    const timing = new StewardshipTimingCollector();
    const block = (status: number, remaining: number, extra: string[] = []) => [
      `HTTP/2.0 ${status} status`, "X-Ratelimit-Resource: graphql", "X-Ratelimit-Limit: 5000",
      `X-Ratelimit-Remaining: ${remaining}`, "X-Ratelimit-Reset: 1792011600", "X-Ratelimit-Used: 4688",
      "Authorization: Bearer private-sentinel", "Location: https://example.test/?private-sentinel",
      "X-Profile-Path: C:/Users/private-sentinel", ...extra, "", '{"authorization":"private-sentinel"}',
      "x-ratelimit-resource: private-sentinel",
    ].join("\r\n");
    timing.includedResponse(block(200, 400));
    timing.includedResponse(block(403, 312, ["Retry-After: private-sentinel"]));
    timing.includedResponse(block(429, 350));
    // Body-only output and body lines after the header separator never count.
    timing.includedResponse('{"message":"rate limited"}\nx-ratelimit-remaining: 0');
    const result = timing.snapshot();
    expect(result.rateLimits).toEqual({ graphql: { minRemaining: 312, lastRemaining: 350,
      lastReset: 1792011600, limit: 5000, lastUsed: 4688, responses403: 1, responses429: 1, retryAfterResponses: 1 } });
    expect(JSON.stringify(result)).not.toMatch(/private-sentinel|authorization|location|profile|retry-after/i);
    const response = new Response(null, { status: 403, headers: { "x-ratelimit-resource": "core",
      "x-ratelimit-remaining": "42", "retry-after": "private-sentinel", authorization: "private-sentinel" } });
    timing.response(response.status, (name) => response.headers.get(name));
    expect(timing.snapshot().rateLimits.core).toMatchObject({ minRemaining: 42, responses403: 1, retryAfterResponses: 1 });
  });

  it("times the existing awaited comments retry sleep without adding attempts", async () => {
    let clock = Date.parse(now); let attempts = 0;
    const timing = new StewardshipTimingCollector(() => clock);
    const github = createStewardshipGitHub({ repository: policy.repository, operator: policy.operator,
      now: () => new Date(clock).toISOString(), deadlineAt: new Date(clock + 60_000).toISOString(), getToken: () => "fixture",
      phaseTiming: timing, collect: async () => ({ evidence: evidenceFixture(), census: { complete: true, nowCount: 0 } }),
      sleep: async (ms) => { clock += ms; },
      fetchImpl: async () => ++attempts === 1 ? new Response(null, { status: 429, headers: { "retry-after": "4" } }) : Response.json([]) });
    await github.observe(1);
    expect(attempts).toBe(2);
    expect(timing.snapshot().phaseTiming["transport.retryWait"]).toMatchObject({ count: 1, totalMs: 4000, retries: 1, sync: false });
    expect(timing.snapshot().phaseTiming).not.toHaveProperty("collect.retryWait");
    expect(timing.snapshot().phaseTiming["observe.comments"]).toMatchObject({ count: 1, totalMs: 4000 });
  });

  it.each(["start", "stop", "retry"])("drops %s exceptions on real observe success and failure paths", async (hook) => {
    const run = async (phaseTiming?: StewardshipTimingCollector) => {
      let attempts = 0; let sleeps = 0; let collects = 0;
      const github = createStewardshipGitHub({ repository: policy.repository, operator: policy.operator,
        now: () => now, deadlineAt: new Date(Date.parse(now) + 60_000).toISOString(), getToken: () => "fixture", phaseTiming,
        collect: async () => { collects++; return { evidence: evidenceFixture(), census: { complete: true, nowCount: 0 } }; },
        sleep: async () => { sleeps++; }, fetchImpl: async () => {
          attempts++;
          if (attempts === 1) return new Response(null, { status: 502 });
          if (attempts === 3) return new Response(null, { status: 401 });
          return Response.json([]);
        } });
      const success = await github.observe(1);
      let failure: unknown;
      try { await github.observe(1); } catch (error) { failure = error; }
      return { success, failure, attempts, sleeps, collects };
    };
    const timing = new StewardshipTimingCollector();
    const fail = () => { throw new Error("telemetry failure"); };
    if (hook === "retry") vi.spyOn(timing, "retry").mockImplementation(fail);
    else vi.spyOn(timing, "start").mockImplementation(hook === "start" ? fail : () => fail);
    const baseline = await run();
    expect(baseline).toMatchObject({ failure: { status: 401 }, attempts: 3, sleeps: 1, collects: 2 });
    expect(await run(timing)).toEqual(baseline);
  });

  it("keeps 1000 real observes and all phase/resource aggregates below 16 KB", async () => {
    let clock = 0;
    const timing = new StewardshipTimingCollector(() => ++clock);
    const github = createStewardshipGitHub({ repository: policy.repository, operator: policy.operator,
      now: () => now, deadlineAt: new Date(Date.parse(now) + 60_000).toISOString(), getToken: () => "fixture",
      phaseTiming: timing, collect: async () => ({ evidence: evidenceFixture(), census: { complete: true, nowCount: 0 } }),
      fetchImpl: async () => Response.json([]) });
    for (let index = 0; index < 1000; index++) {
      await github.observe(1);
      for (const phase of STEWARDSHIP_TIMING_PHASES.filter((name) => !name.startsWith("observe."))) {
        timeStewardshipSync(timing, phase, () => {});
      }
      timing.includedResponse(`HTTP/2.0 200 OK\nx-ratelimit-resource: resource-${index}\nx-ratelimit-remaining: ${index}\n\n{}`);
      timing.includedResponse(`HTTP/2.0 200 OK\nx-ratelimit-resource: graphql\nx-ratelimit-remaining: ${index}\n\n{}`);
    }
    const snapshot = timing.snapshot();
    expect(snapshot.phaseTiming["observe.total"]?.count).toBe(1000);
    expect(Object.keys(snapshot.rateLimits)).toEqual(["unknown", "graphql"]);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(16 * 1024);
  });
});
