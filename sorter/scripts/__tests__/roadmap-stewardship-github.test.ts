import { describe, expect, it, vi } from "vitest";
import { createStewardshipGitHub, createStewardshipRehearsalTransport } from "../lib/github-issue-roadmap/stewardship-github";
import { canonicalJsonSha256, sha256Bytes } from "../lib/github-issue-roadmap/canonical-json";
import { assessmentFixture, evidenceFixture, now, policy } from "./fixtures/roadmap-stewardship";
import { freezeStewardshipAssessment, type StewardshipAssessment } from "../lib/github-issue-roadmap/stewardship-assessment";
import { compileStewardshipDecision } from "../lib/github-issue-roadmap/stewardship-decision";
import type { StewardshipEvidenceGeneration, StewardshipTargetResult } from "../lib/github-issue-roadmap/stewardship-evidence";
import { StewardshipTimingCollector } from "../lib/github-issue-roadmap/stewardship-phase-timing";

const fields = [{ id: 10, name: "Priority", data_type: "single_select", options: [{ name: "P2" }, { name: "P3" }] },
  { id: 20, name: "Horizon", data_type: "single_select", options: [{ name: "Now" }, { name: "Later" }] }];
function setup(respond: (url: string, init: RequestInit) => Response | Promise<Response> = () => Response.json(fields), actor = policy.operator) {
  const getToken = vi.fn(() => "test-credential-never-log");
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => String(url).endsWith("/user") ? Response.json({ login: actor }) : respond(String(url), init!));
  const collect = vi.fn(async () => ({ evidence: evidenceFixture(), census: { complete: true, nowCount: 1 } }));
  let clock = Date.parse(now); const sleep = vi.fn(async (ms: number) => { clock += ms; });
  const adapter = createStewardshipGitHub({ repository: "example-org/example-repo", operator: policy.operator, getToken, fetchImpl, collect,
    now: () => new Date(clock).toISOString(), deadlineAt: new Date(clock + 60000).toISOString(), sleep });
  return { adapter, getToken, fetchImpl, collect, sleep, advance: (ms: number) => { clock += ms; } };
}
describe("target stewardship GitHub transport", () => {
  it("copies only read capabilities, with no inherited write property", () => {
    const adapter = Object.assign(Object.create({ delete: vi.fn(), send: vi.fn() }), {
      observe: vi.fn(), observeMany: vi.fn(), observeTarget: vi.fn(), send: vi.fn(), write: vi.fn(),
    });
    const facade = createStewardshipRehearsalTransport(adapter, () => ({}));
    expect(Object.getPrototypeOf(facade)).toBeNull();
    expect(Object.getOwnPropertyNames(facade).sort()).toEqual(["observe", "observeMany", "observeTarget", "rateLimits"]);
    expect("send" in facade).toBe(false); expect("write" in facade).toBe(false); expect("delete" in facade).toBe(false);
    expect(Object.isFrozen(facade)).toBe(true);
    // @ts-expect-error The rehearsal capability has no mutation method.
    void facade.send;
  });
  function targetSetup() {
    const evidence = evidenceFixture();
    const result: StewardshipTargetResult = { issueNumber: 1, status: "ok", packet: evidence.packet,
      comments: [{ id: 7, body: "Complete raw comment" }], commentsComplete: true,
      targetCompleteness: { complete: true, reads: ["anchorA", "hydration1", "history", "comments", "hydration2", "relationships", "anchorB"] } };
    const collectTarget = vi.fn(() => ({ originMainSha: evidence.originMainSha, policySha256: evidence.policySha256,
      targetResults: [result] as StewardshipTargetResult[] }));
    const collect = vi.fn(async () => ({ evidence, census: { complete: true, nowCount: 1 } }));
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = createStewardshipGitHub({ repository: "example-org/example-repo", operator: policy.operator, getToken: () => "fixture",
      collect, collectTarget, fetchImpl, now: () => now, deadlineAt: new Date(Date.parse(now) + 60000).toISOString() });
    return { evidence, result, collectTarget, collect, fetchImpl, adapter };
  }

  it("returns explicit target completeness and complete comments with no census", async () => {
    const value = targetSetup();
    const result = await value.adapter.observeTarget!(1);
    expect(value.collectTarget).toHaveBeenCalledExactlyOnceWith({ selection: { mode: "targeted", issueNumbers: [1] },
      targetObservation: true, targetResults: true, withComments: true, stabilityScope: "selected" });
    expect(result).toEqual({ issueNumber: 1, status: "ok", evidence: value.evidence, comments: value.result.comments,
      commentsComplete: true, targetCompleteness: value.result.targetCompleteness });
    expect(result).not.toHaveProperty("census");
    expect(value.collect).not.toHaveBeenCalled(); expect(value.fetchImpl).not.toHaveBeenCalled();
  });
  it("passes the one-hydration readback option only when requested", async () => {
    const value = targetSetup();
    await value.adapter.observeTarget!(1, { readback: true });
    expect(value.collectTarget).toHaveBeenCalledExactlyOnceWith({ selection: { mode: "targeted", issueNumbers: [1] },
      targetObservation: true, targetReadback: true, targetResults: true, withComments: true, stabilityScope: "selected" });
    value.collectTarget.mockClear();
    await value.adapter.observeTarget!(1);
    expect(value.collectTarget).toHaveBeenCalledExactlyOnceWith({ selection: { mode: "targeted", issueNumbers: [1] },
      targetObservation: true, targetResults: true, withComments: true, stabilityScope: "selected" });
  });

  it.each(["absent", "unstable", "unavailable"] as const)("preserves the %s target result and cause", async (status) => {
    const value = targetSetup();
    const result = { issueNumber: 1, status, cause: "target_anchorB", nextEligibleAt: null };
    value.collectTarget.mockReturnValue({ originMainSha: value.evidence.originMainSha, policySha256: value.evidence.policySha256, targetResults: [result] });
    expect(await value.adapter.observeTarget!(1)).toEqual(result);
    expect(value.collect).not.toHaveBeenCalled();
  });

  it.each(["missing", "duplicate", "comments", "predicate", "identity", "closed"])("refuses %s target evidence", async (kind) => {
    const value = targetSetup();
    const result = { ...value.result };
    if (kind === "comments") delete result.commentsComplete;
    if (kind === "predicate") delete result.targetCompleteness;
    if (kind === "identity") result.packet = { ...result.packet, issueNumber: 2 };
    if (kind === "closed") result.packet = { ...result.packet, issue: { ...result.packet.issue, v1: { ...result.packet.issue.v1, state: "CLOSED" } } };
    value.collectTarget.mockReturnValue({ originMainSha: value.evidence.originMainSha, policySha256: value.evidence.policySha256,
      targetResults: kind === "missing" ? [] : kind === "duplicate" ? [result, result] : [result] });
    expect(await value.adapter.observeTarget!(1)).toMatchObject({ issueNumber: 1, status: "unavailable", cause: expect.any(String) });
  });

  it("validates the target before collecting and never falls back to the census", async () => {
    const value = targetSetup();
    await expect(value.adapter.observeTarget!(0)).rejects.toThrow();
    expect(value.collectTarget).not.toHaveBeenCalled();
    const legacy = setup();
    await expect(legacy.adapter.observeTarget!(1)).rejects.toThrow();
    expect(legacy.collect).not.toHaveBeenCalled();
  });

  it.each(["anchorA", "hydration1", "history", "comments", "hydration2", "relationships", "anchorB"])(
    "rejects a substitute collector claiming completeness without %s at the type level", (skipped) => {
      const value = targetSetup();
      const result = { ...value.result, targetCompleteness: { complete: true as const,
        reads: value.result.targetCompleteness!.reads.filter((read) => read !== skipped) } };
      const substitute = () => ({ originMainSha: value.evidence.originMainSha, policySha256: value.evidence.policySha256, targetResults: [result] });
      // @ts-expect-error A complete result requires the entire ordered reads tuple.
      const collectTarget: NonNullable<Parameters<typeof createStewardshipGitHub>[0]["collectTarget"]> = substitute;
      expect(collectTarget).toBe(substitute);
      expect(result.targetCompleteness.reads).toHaveLength(6);
      expect(result.targetCompleteness.reads).not.toContain(skipped);
    });

  it("reads page 2 when the shared comments pager receives uppercase NEXT", async () => {
    const value = setup((url) => url.includes("page=2") ? Response.json([{ id: 2 }]) : Response.json([{ id: 1 }], {
      headers: { link: '<https://api.github.com/repos/example-org/example-repo/issues/1/comments?per_page=100&page=2>; rel="NEXT"' },
    }));
    expect((await value.adapter.observe(1)).comments).toEqual([{ id: 1 }, { id: 2 }]);
    expect(value.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails closed on a malformed uppercase NEXT link", async () => {
    const value = setup(() => Response.json([], { headers: { link: 'malformed; rel="NEXT"' } }));
    await expect(value.adapter.observe(1)).rejects.toThrow();
  });
});

describe("stewardship GitHub transport", () => {
  const sortKeyField = { id: 48839784, name: "Sort key", data_type: "number" };
  it.each([19200, "19200", 19200.5])("posts an integer Sort key and confirms only numeric readback %j", async (returned) => {
    const value = setup((_url, init) => init.method === "GET" ? Response.json([...fields, sortKeyField])
      : Response.json([{ issue_field_id: sortKeyField.id, node_id: "IFNV_fixture", data_type: "number", issue_field_name: "Sort key", value: returned }]));
    const receipt = await value.adapter.send(1, { kind: "set_sort_key", value: 19200 }, undefined, async () => {});
    const writes = value.fetchImpl.mock.calls.filter((call) => call[1]?.method === "POST");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0][1]!.body))).toEqual({ issue_field_values: [{ field_id: sortKeyField.id, value: 19200 }] });
    expect(receipt).toMatchObject({ targetFieldValuePresent: returned === 19200 });
  });
  it.each([19200.5, -1, "19200"])("refuses invalid Sort key operation %j before any request", async (target) => {
    const value = setup();
    await expect(value.adapter.send(1, { kind: "set_sort_key", value: target } as never, undefined, async () => {})).rejects.toThrow();
    expect(value.fetchImpl).not.toHaveBeenCalled(); expect(value.getToken).not.toHaveBeenCalled();
  });
  it.each([
    { definition: { ...sortKeyField, name: "Priority" }, operation: { kind: "set_priority", value: "P3" } },
    { definition: { ...sortKeyField, data_type: "single_select", options: [{ name: "19200" }] }, operation: { kind: "set_sort_key", value: 19200 } },
    { definition: { ...sortKeyField, data_type: "single_select" }, operation: { kind: "clear_sort_key" } },
  ])("refuses a mismatched field definition for $operation.kind", async ({ definition, operation }) => {
    const value = setup(() => Response.json([definition])); const fence = vi.fn();
    await expect(value.adapter.send(1, operation as never, undefined, fence)).rejects.toMatchObject({ sent: false });
    expect(fence).not.toHaveBeenCalled();
    expect(value.fetchImpl.mock.calls.every((call) => call[1]?.method === "GET")).toBe(true);
  });
  it("clears Sort key through its resolved field-ID DELETE", async () => {
    const value = setup((_url, init) => init.method === "GET" ? Response.json([...fields, sortKeyField]) : new Response(null, { status: 204 }));
    await value.adapter.send(1, { kind: "clear_sort_key" }, undefined, async () => {});
    const writes = value.fetchImpl.mock.calls.filter((call) => call[1]?.method !== "GET");
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe(`https://api.github.com/repos/example-org/example-repo/issues/1/issue-field-values/${sortKeyField.id}`);
    expect(writes[0][1]).toMatchObject({ method: "DELETE" });
    expect(writes[0][1]!.body).toBeUndefined();
  });
  function batchSetup(targetResults: readonly StewardshipTargetResult[], phaseTiming?: StewardshipTimingCollector) {
    const evidence = evidenceFixture();
    const collectMany = vi.fn((): StewardshipEvidenceGeneration => ({ schemaVersion: "github-issue-roadmap-stewardship-evidence/v1",
      evidencePhase: "initial", generation: 1, generatedAt: now, repository: evidence.packet.issue.identity.repository,
      originMainSha: evidence.originMainSha, policySha256: evidence.policySha256, materialEvidenceSha256: evidence.packet.materialEvidenceSha256,
      census: { complete: true, totalCount: 3, nowCount: 1, issueNumbers: [1, 2, 3] }, selectedIssueNumbers: [1, 2, 3, 4],
      baselines: [], packets: targetResults.flatMap((entry) => entry.status === "ok" ? [entry.packet] : []),
      deferredIssues: [], transport: [], targetResults }));
    const collect = vi.fn(async () => ({ evidence, census: { complete: true, nowCount: 1 } }));
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = createStewardshipGitHub({ repository: "example-org/example-repo", operator: policy.operator, getToken: () => "fixture",
      collect, collectMany, fetchImpl, phaseTiming, now: () => now, deadlineAt: new Date(Date.parse(now) + 60000).toISOString() });
    return { adapter, collectMany, collect, fetchImpl };
  }

  it("observes a batch with explicit mixed results and the single-observe success shape", async () => {
    const evidence = evidenceFixture(); const comments = [{ id: 7, body: "Raw comment" }];
    const value = batchSetup([{ issueNumber: 1, status: "ok", packet: evidence.packet, comments, commentsComplete: true },
      { issueNumber: 2, status: "unavailable" }, { issueNumber: 3, status: "unstable" }, { issueNumber: 4, status: "absent" }]);
    const results = await value.adapter.observeMany!([1, 2, 3, 4]);
    expect(value.collectMany).toHaveBeenCalledExactlyOnceWith({ selection: { mode: "targeted", issueNumbers: [1, 2, 3, 4] },
      targetResults: true, withComments: true, stabilityScope: "selected" });
    expect(results).toEqual([{ issueNumber: 1, status: "ok", evidence, census: { complete: true, nowCount: 1 }, comments, commentsComplete: true },
      { issueNumber: 2, status: "unavailable" }, { issueNumber: 3, status: "unstable" }, { issueNumber: 4, status: "absent" }]);
    expect(value.collect).not.toHaveBeenCalled(); expect(value.fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["missing", "duplicate", "comments", "identity"])("never infers successful batch observation from %s results", async (kind) => {
    const packet = evidenceFixture().packet;
    const ok = { issueNumber: 1, status: "ok" as const, packet, comments: [], commentsComplete: true as const };
    const value = batchSetup(kind === "missing" ? [] : kind === "duplicate" ? [ok, ok] : kind === "comments"
      ? [{ issueNumber: 1, status: "ok", packet }] : [{ ...ok, packet: { ...packet, issueNumber: 2 } }]);
    expect(await value.adapter.observeMany!([1])).toEqual([{ issueNumber: 1, status: "unavailable" }]);
  });

  it.each(["start", "stop"])("preserves incomplete batch census and observation when timing %s throws", async (failure) => {
    const timing = new StewardshipTimingCollector();
    vi.spyOn(timing, "start").mockImplementation(() => {
      if (failure === "start") throw new Error("Telemetry unavailable");
      return () => { throw new Error("Telemetry unavailable"); };
    });
    const evidence = evidenceFixture();
    const value = batchSetup([{ issueNumber: 1, status: "ok", packet: evidence.packet, comments: [], commentsComplete: true }], timing);
    const collect = value.collectMany.getMockImplementation()!;
    value.collectMany.mockImplementation(() => { const result = collect(); return { ...result, census: { ...result.census, complete: false } }; });
    expect(await value.adapter.observeMany!([1])).toEqual([{ issueNumber: 1, status: "ok", evidence,
      census: { complete: false, nowCount: 1 }, comments: [], commentsComplete: true }]);
    expect(value.collectMany).toHaveBeenCalledTimes(1);
    expect(value.fetchImpl).not.toHaveBeenCalled();
  });

  it("enforces the batch bound before any collection", async () => {
    const value = batchSetup([]);
    for (const targets of [[], [0], Array.from({ length: 13 }, (_, index) => index + 1)]) {
      await expect(value.adapter.observeMany!(targets)).rejects.toThrow();
    }
    expect(value.collectMany).not.toHaveBeenCalled();
  });

  it("resolves Lifecycle names live, sets once, clears with DELETE, and names unresolved options", async () => {
    const value = setup((_url, init) => init.method === "GET" ? Response.json([...fields,
      { id: 48026132, name: "Lifecycle", data_type: "single_select", options: [{ name: "Done candidate" }] }]) : new Response(null, { status: 204 }));
    await value.adapter.send(1, { kind: "set_lifecycle", value: "Done candidate" } as never, undefined, async () => {});
    await value.adapter.send(1, { kind: "clear_lifecycle" } as never, undefined, async () => {});
    const writes = value.fetchImpl.mock.calls.filter((call) => call[1]?.method !== "GET");
    expect(writes).toHaveLength(2);
    expect(JSON.parse(String(writes[0][1]!.body))).toEqual({ issue_field_values: [{ field_id: 48026132, value: "Done candidate" }] });
    expect(writes[1][0]).toContain("/issue-field-values/48026132");
    expect(writes[1][1]).toMatchObject({ method: "DELETE" });
    await expect(value.adapter.send(1, { kind: "set_lifecycle", value: "Stale candidate" } as never, undefined, async () => {})).rejects.toThrow(/Lifecycle.*Stale candidate/);
  });
  it("resolves Effort live and deletes only Priority", async () => {
    const value = setup((_url, init) => init.method === "GET" ? Response.json([...fields,
      { id: 37, name: "Effort", data_type: "single_select", options: [{ name: "Low" }] }]) : new Response(null, { status: 204 }));
    await value.adapter.send(1, { kind: "set_effort", value: "Low" }, undefined, async () => {});
    await value.adapter.send(1, { kind: "clear_priority" }, undefined, async () => {});
    const writes = value.fetchImpl.mock.calls.filter((call) => call[1]?.method !== "GET");
    expect(JSON.parse(String(writes[0][1]!.body))).toEqual({ issue_field_values: [{ field_id: 37, value: "Low" }] });
    expect(writes[1][0]).toContain("/issue-field-values/10");
    expect(writes[1][1]).toMatchObject({ method: "DELETE" });
    await expect(value.adapter.send(1, { kind: "set_effort", value: "High" }, undefined, async () => {})).rejects.toThrow(/Effort.*High/);
  });
  it("refuses a credential for another actor before admitting a write", async () => {
    const value = setup(undefined, "different-owner"); const fence = vi.fn();
    await expect(value.adapter.send(1, { kind: "set_priority", value: "P3" }, undefined, fence)).rejects.toMatchObject({ sent: false });
    expect(fence).not.toHaveBeenCalled();
    expect(value.fetchImpl.mock.calls.every((call) => call[1]?.method === "GET")).toBe(true);
  });
  it.each([400, 401, 403, 404, 422, 429])("records explicit HTTP %s rejection separately from unknown effects", async (status) => {
    const value = setup((_url, init) => init.method === "GET" ? Response.json(fields) : new Response("remote secret", { status, headers: { "retry-after": "120" } }));
    await expect(value.adapter.send(1, { kind: "set_priority", value: "P3" }, undefined, async () => {})).rejects.toMatchObject({ status, sent: true, definitelyRejected: true });
    expect(value.fetchImpl.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    expect(value.sleep).not.toHaveBeenCalled();
  });
  it("sends a nonempty one-field POST and resolves definitions before the final fence", async () => {
    const order: string[] = [];
    const value = setup((_url, init) => { order.push(init.method!); return init.method === "GET" ? Response.json(fields) : Response.json([]); });
    await value.adapter.send(1, { kind: "set_priority", value: "P3" }, undefined, async () => { order.push("fence"); });
    expect(order).toEqual(["GET", "fence", "POST"]);
    const [url, init] = value.fetchImpl.mock.calls[2];
    expect(url).toBe("https://api.github.com/repos/example-org/example-repo/issues/1/issue-field-values");
    expect(JSON.parse(String(init!.body))).toEqual({ issue_field_values: [{ field_id: 10, value: "P3" }] });
    expect(init!.redirect).toBe("error");
  });
  it.each([
    { body: '[{"field_id":10,"value":"P3"}]', present: true },
    { body: '{"issue_field_values":[{"issue_field":{"id":10},"single_select_option":{"name":"P3"}}]}', present: true },
    { body: '[{"field_id":20,"value":"P3"},{"field_id":10,"value":"P2"}]', present: false },
    { body: "[]", present: false },
    { body: '{"message":"test-credential-never-log"}', present: null },
    { body: "PRIVATE-RAW-BODY", present: null },
  ])("captures bounded field send diagnostics with match=$present (F-LIVE-3): $body", async ({ body, present }) => {
    const value = setup((_url, init) => init.method === "GET" ? Response.json(fields)
      : new Response(body, { status: 201, headers: { "x-github-request-id": "ABC:123._-xyz" } }));
    const receipt = await value.adapter.send(1, { kind: "set_priority", value: "P3" }, undefined, async () => {});
    expect(receipt).toEqual({ httpStatus: 201, requestId: "ABC:123._-xyz", responseBodyBytes: Buffer.byteLength(body),
      responseBodySha256: sha256Bytes(body), targetFieldValuePresent: present });
    expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE-RAW-BODY|test-credential-never-log/);
    expect(value.fetchImpl.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    expect(value.sleep).not.toHaveBeenCalled();
  });
  it("retains an accepted write receipt when reading its body crosses the deadline", async () => {
    const body = '[{"field_id":10,"value":"P3"}]';
    const value = setup((_url, init) => init.method === "GET" ? Response.json(fields)
      : new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          value.advance(60_001);
          controller.enqueue(Buffer.from(body)); controller.close();
        },
      }, { highWaterMark: 0 }), { status: 201, headers: { "x-github-request-id": "ACCEPTED:1" } }));
    await expect(value.adapter.send(1, { kind: "set_priority", value: "P3" }, undefined, async () => {}))
      .resolves.toEqual({ httpStatus: 201, requestId: "ACCEPTED:1", responseBodyBytes: Buffer.byteLength(body),
        responseBodySha256: sha256Bytes(body), targetFieldValuePresent: true });
    expect(value.fetchImpl.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    expect(value.sleep).not.toHaveBeenCalled();
  });
  it.each(["invalid request id", "<private>", "x".repeat(129), "", "test-credential-never-log"])("omits invalid or credential-bearing request-id %j from the send receipt", async (requestId) => {
    const value = setup((_url, init) => init.method === "GET" ? Response.json(fields)
      : new Response("[]", { headers: { "x-github-request-id": requestId } }));
    expect(await value.adapter.send(1, { kind: "set_priority", value: "P3" }, undefined, async () => {}))
      .toMatchObject({ requestId: null });
  });
  it.each(["empty", "oversized", "interrupted"] as const)("keeps a successful send single-attempt with an %s body", async (kind) => {
    const value = setup((_url, init) => init.method === "GET" ? Response.json(fields) : kind === "empty" ? new Response(null, { status: 204 })
      : kind === "oversized" ? new Response("x".repeat(2 * 1024 * 1024 + 1))
        : new Response(new ReadableStream({ start(controller) { controller.error(new Error("PRIVATE-STREAM-ERROR")); } })));
    const receipt = await value.adapter.send(1, { kind: "set_priority", value: "P3" }, undefined, async () => {});
    expect(receipt).toEqual({ httpStatus: kind === "empty" ? 204 : 200, requestId: null,
      responseBodyBytes: kind === "empty" ? 0 : null, responseBodySha256: kind === "empty" ? sha256Bytes("") : null, targetFieldValuePresent: null });
    expect(value.fetchImpl.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    expect(value.sleep).not.toHaveBeenCalled();
  });
  it("clears only the resolved Horizon field and refuses unsupported authority before credential access", async () => {
    const value = setup((_url, init) => init.method === "GET" ? Response.json(fields) : new Response(null, { status: 204 }));
    await value.adapter.send(1, { kind: "clear_horizon" }, undefined, async () => {});
    expect(value.fetchImpl.mock.calls[2][0]).toContain("/issue-field-values/20");
    expect(value.fetchImpl.mock.calls[2][1]).toMatchObject({ method: "DELETE" });
    const invalid = setup();
    await expect(invalid.adapter.send(1, { kind: "clear_effort" } as never, undefined, async () => {})).rejects.toThrow();
    await expect(invalid.adapter.send(1, { kind: "set_priority", value: "P3", extra: true } as never, undefined, async () => {})).rejects.toThrow();
    expect(invalid.getToken).not.toHaveBeenCalled(); expect(invalid.fetchImpl).not.toHaveBeenCalled();
  });
  it("does not send after a final fence refusal or ambiguous field definitions", async () => {
    const value = setup();
    await expect(value.adapter.send(1, { kind: "set_priority", value: "P3" }, undefined, async () => { throw new Error("paused"); })).rejects.toThrow("paused");
    expect(value.fetchImpl).toHaveBeenCalledTimes(2);
    const ambiguous = setup(() => Response.json([...fields, fields[0]]));
    const fence = vi.fn();
    await expect(ambiguous.adapter.send(1, { kind: "set_priority", value: "P3" }, undefined, fence)).rejects.toThrow();
    expect(fence).not.toHaveBeenCalled();
  });
  it("admits only exact compiled comment formats bound to the target and body hash", async () => {
    const body = ["<!-- github-issue-roadmap-stewardship-decision:v1 -->", "Issue: 1", "Priority: P2 -> P3", "Horizon: Now -> Later",
      `Current main: ${"a".repeat(40)}`, `Evidence: ${"b".repeat(64)}`, `Assessments: ${"c".repeat(64)},${"d".repeat(64)}`].join("\n");
    const value = setup(() => Response.json({ id: 1 }));
    const operation = { kind: "append_comment" as const, purpose: "decision" as const, bodySha256: canonicalJsonSha256(body) };
    expect(await value.adapter.send(1, operation, body, async () => {})).toEqual({
      httpStatus: 200, requestId: null, responseBodyBytes: Buffer.byteLength('{"id":1}'),
      responseBodySha256: sha256Bytes('{"id":1}'), targetFieldValuePresent: null,
    });
    expect(value.fetchImpl.mock.calls[1][1]!.body).toBe(JSON.stringify({ body }));
    for (const [issue, text] of [[2, body], [1, `${body}\nextra arbitrary content`]] as const) {
      const denied = setup();
      await expect(denied.adapter.send(issue, { ...operation, bodySha256: canonicalJsonSha256(text) }, text, async () => {})).rejects.toThrow();
      expect(denied.getToken).not.toHaveBeenCalled();
    }
  });
  it("never retries a possibly applied write or exposes raw remote errors", async () => {
    const value = setup((_url, init) => init.method === "GET" ? Response.json(fields) : new Response("test-credential-never-log", { status: 503 }));
    await expect(value.adapter.send(1, { kind: "set_priority", value: "P3" }, undefined, async () => {})).rejects.toMatchObject({ status: 503, sent: true });
    expect(value.fetchImpl).toHaveBeenCalledTimes(3); expect(value.sleep).not.toHaveBeenCalled();
  });
  it("accepts the verification and decision comments produced by the actual compiler", async () => {
    const evidence = evidenceFixture(); const assessment: StewardshipAssessment = assessmentFixture(evidence);
    assessment.proposed.Horizon = "Now"; assessment.sequencing.disposition = "now";
    const assessments = (["anthropic", "glm"] as const).map((family) => freezeStewardshipAssessment({ evidence, policy, assessment,
      seat: { family, requestedModel: family, observedModel: "unknown" }, assessedAt: now }));
    const decision = compileStewardshipDecision({ evidence, assessments, policy, now, census: { complete: true, nowCount: 0 } });
    expect(decision.status).toBe("eligible"); expect(decision.comments).toHaveLength(2);
    const value = setup(() => Response.json({ id: 1 }));
    for (const comment of decision.comments) await value.adapter.send(1,
      { kind: "append_comment", purpose: comment.purpose, bodySha256: comment.bodySha256 }, comment.body, async () => {});
    expect(value.fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("returns complete targeted observation and follows only same-resource comment pagination", async () => {
    const value = setup((url) => url.includes("page=2") ? Response.json([{ id: 2 }]) : Response.json([{ id: 1 }], {
      headers: { link: '<https://api.github.com/repos/example-org/example-repo/issues/1/comments?per_page=100&page=2>; rel="next"' },
    }));
    const observation = await value.adapter.observe(1);
    expect(value.collect).toHaveBeenCalledWith(1);
    expect(observation.comments).toEqual([{ id: 1 }, { id: 2 }]); expect(observation.commentsComplete).toBe(true);
    const escaped = setup(() => Response.json([], { headers: { link: '<https://outside.invalid/comments?page=2>; rel="next"' } }));
    await expect(escaped.adapter.observe(1)).rejects.toThrow(); expect(escaped.fetchImpl).toHaveBeenCalledOnce();
  });
  it("honors the later rate reset/Retry-After within the deadline and stops beyond it", async () => {
    let count = 0;
    const value = setup(() => ++count === 1 ? new Response(null, { status: 429, headers: { "retry-after": "2", "x-ratelimit-reset": String(Date.parse(now) / 1000 + 4) } }) : Response.json([]));
    await value.adapter.observe(1); expect(value.sleep).toHaveBeenCalledWith(4000);
    const denied = setup(() => new Response(null, { status: 429, headers: { "retry-after": "120" } }));
    await expect(denied.adapter.observe(1)).rejects.toMatchObject({ status: 429, nextEligibleAt: new Date(Date.parse(now) + 120000).toISOString() });
    expect(denied.fetchImpl).toHaveBeenCalledOnce(); expect(denied.sleep).not.toHaveBeenCalled();
  });
  it("refuses malformed next links rather than claiming complete comments", async () => {
    const value = setup(() => Response.json([], { headers: { link: 'malformed; rel="next"' } }));
    await expect(value.adapter.observe(1)).rejects.toThrow();
    expect(value.fetchImpl).toHaveBeenCalledOnce();
  });
  it("caps transient attempts and response bytes and refuses unknown rate-reset times", async () => {
    const transport = setup(async () => { throw new Error("test-credential-never-log"); });
    await expect(transport.adapter.observe(1)).rejects.toThrow("Stewardship GitHub request refused or incomplete");
    expect(transport.fetchImpl).toHaveBeenCalledTimes(3);
    const large = setup(() => Response.json([{ body: "x".repeat(2 * 1024 * 1024) }]));
    await expect(large.adapter.observe(1)).rejects.toThrow(); expect(large.fetchImpl).toHaveBeenCalledTimes(3);
    const limited = setup(() => new Response(null, { status: 429 }));
    await expect(limited.adapter.observe(1)).rejects.toMatchObject({ status: 429 });
    expect(limited.fetchImpl).toHaveBeenCalledOnce();
  });
});
