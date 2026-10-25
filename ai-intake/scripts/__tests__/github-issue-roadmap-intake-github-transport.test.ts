import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGitHubIntakeApprovalTransport } from "../lib/github-issue-roadmap/github-intake-approval-transport";
import { CANONICAL_REST_API_VERSION } from "../lib/github-issue-roadmap/snapshot-v2";
import { acquireExecutionClaim, ExecutionOwnershipError } from "../lib/github-issue-roadmap/intake-execution-journal";
import { compareLegacyClassification } from "../lib/github-issue-roadmap/intake-legacy-verification";

function fetchStubReturning(payload: unknown, status = 200) {
  const calls: { readonly input: URL | RequestInfo; readonly init?: RequestInit }[] = [];
  const fetchImpl = async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

describe("filing field-write receipts", () => {
  const writeStartedAt = "2026-10-06T12:00:00.000Z";
  const eventCreatedAt = "2026-10-06T12:00:01Z";
  const readBackAt = "2026-10-06T12:00:03.000Z";
  const added = {
    __typename: "IssueFieldAddedEvent", id: "IFAE_filed", actor: { login: "filing-bot" }, createdAt: eventCreatedAt,
    issueField: { id: "IF_priority", fullDatabaseId: "91", name: "Priority" }, options: [{ name: "P2" }], value: null,
  };
  const changed = {
    __typename: "IssueFieldChangedEvent", id: "IFCE_filed", actor: { login: "filing-bot" }, createdAt: eventCreatedAt,
    issueField: { id: "IF_effort", fullDatabaseId: "92", name: "Effort" },
    newOptions: [{ name: "Medium" }], previousOptions: [{ name: "Low" }], newValue: null, previousValue: null,
  };
  const removed = {
    __typename: "IssueFieldRemovedEvent", id: "IFRE_human", actor: { login: "human" }, createdAt: eventCreatedAt,
    issueField: added.issueField, options: [{ name: "P1" }],
  };
  const timeline = (nodes: readonly unknown[]) => ({ data: { repository: { issue: { timelineItems: { nodes } } } } });
  const snapshot = { eventIds: new Set<string>(), currentValue: null };
  const requested = { fieldName: "Priority" as const, value: "P2", writeStartedAt, snapshot };

  function fixture(payload: unknown = timeline([added]), viewer: unknown = { data: { viewer: { login: "filing-bot" } } }) {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/orgs/example-org/issue-fields?per_page=100")) return Response.json([
        { id: 91, node_id: "IF_priority", name: "Priority", options: [{ name: "P2" }] },
        { id: 92, node_id: "IF_effort", name: "Effort", options: [{ name: "Medium" }] },
      ]);
      expect(String(url)).toBe("https://api.github.com/graphql");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-token");
      const body = JSON.parse(String(init?.body));
      if (/viewer\s*\{\s*login\s*\}/.test(body.query)) return Response.json(viewer);
      expect(body.variables).toEqual({ owner: "example-org", repo: "example-repo", number: 42 });
      expect(body.query).toMatch(/timelineItems\(last: 100/);
      expect(body.query).toContain("ISSUE_FIELD_ADDED_EVENT");
      expect(body.query).toContain("ISSUE_FIELD_CHANGED_EVENT");
      if (payload instanceof Error) throw payload;
      if (vi.isFakeTimers()) vi.setSystemTime(new Date(readBackAt));
      return payload instanceof Response ? payload : Response.json(payload);
    });
    return { transport: createGitHubIntakeApprovalTransport({ token: "fixture-token", fetchImpl }), fetchImpl };
  }

  afterEach(() => vi.useRealTimers());

  it.each([
    { event: added, fieldName: "Priority", value: "P2" },
    { event: changed, fieldName: "Effort", value: "Medium" },
    { event: { ...added, createdAt: writeStartedAt }, fieldName: "Priority", value: "P2" },
    { event: { ...added, options: [], value: "P2" }, fieldName: "Priority", value: "P2" },
    { event: { ...added, issueField: { fullDatabaseId: "91", name: "Priority" } }, fieldName: "Priority", value: "P2" },
    { event: { ...added, issueField: { id: "IF_priority", name: "Priority" } }, fieldName: "Priority", value: "P2" },
  ] as const)("returns the sole matching $fieldName event and response time", async ({ event, fieldName, value }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(writeStartedAt));
    const { transport, fetchImpl } = fixture(timeline([event]));
    await expect(transport.readBackFieldWrite("example-org/example-repo", 42, { fieldName, value, writeStartedAt, snapshot }))
      .resolves.toEqual({ eventId: event.id, eventCreatedAt: event.createdAt, readBackAt, writeStartedAt });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("reads viewer.login once per transport instance", async () => {
    const { transport, fetchImpl } = fixture();
    await transport.readBackFieldWrite("example-org/example-repo", 42, requested);
    await transport.readBackFieldWrite("example-org/example-repo", 42, requested);
    expect(fetchImpl.mock.calls.filter(([, init]) => /viewer\s*\{/.test(String(init?.body)))).toHaveLength(1);
  });

  it("queries field removals with their field identity and removed options", async () => {
    const { transport, fetchImpl } = fixture();
    await transport.snapshotFieldEvents("example-org/example-repo", 42, "Priority");
    const query = JSON.parse(String(fetchImpl.mock.calls.at(-1)![1]?.body)).query;
    expect(query).toMatch(/itemTypes: \[[^\]]*ISSUE_FIELD_REMOVED_EVENT/);
    expect(query).toContain("... on IssueFieldRemovedEvent { __typename id actor { login } createdAt issueField { ... on IssueFieldSingleSelect { id fullDatabaseId name } } options { name } }");
  });

  it("does not receipt an add after a human removes the snapshotted value", async () => {
    const initial = { ...added, id: "IFAE_initial", options: [{ name: "P1" }] };
    const nodes: unknown[] = [initial];
    const { transport } = fixture(timeline(nodes));
    const before = await transport.snapshotFieldEvents("example-org/example-repo", 42, "Priority");
    expect(before).toEqual({ eventIds: new Set([initial.id]), currentValue: "P1" });
    nodes.push(removed, added);
    await expect(transport.readBackFieldWrite("example-org/example-repo", 42, { ...requested, snapshot: before })).resolves.toBeNull();
  });

  it("snapshots a removal as unset and receipts exactly one subsequent add", async () => {
    const nodes: unknown[] = [{ ...added, options: removed.options }, removed];
    const { transport } = fixture(timeline(nodes));
    const before = await transport.snapshotFieldEvents("example-org/example-repo", 42, "Priority");
    expect(before).toEqual({ eventIds: new Set([added.id, removed.id]), currentValue: null });
    nodes.push({ ...added, id: "IFAE_after_removal" });
    await expect(transport.readBackFieldWrite("example-org/example-repo", 42, { ...requested, snapshot: before }))
      .resolves.toMatchObject({ eventId: "IFAE_after_removal" });
  });

  it("never receipts a removal even when its actor and removed option match", async () => {
    const event = { ...removed, actor: added.actor, options: added.options };
    await expect(fixture(timeline([event])).transport.readBackFieldWrite("example-org/example-repo", 42, requested)).resolves.toBeNull();
  });

  it.each(["snapshot", "read-back"])("makes %s inconclusive for a named field without either id", async phase => {
    const unidentified = { ...added, id: "IFAE_unidentified", issueField: { name: "Priority" } };
    const { transport } = fixture(timeline([unidentified, added]));
    if (phase === "snapshot") {
      await expect(transport.snapshotFieldEvents("example-org/example-repo", 42, "Priority")).resolves.toBeNull();
    } else {
      await expect(transport.readBackFieldWrite("example-org/example-repo", 42, {
        ...requested, snapshot: { eventIds: new Set([added.id]), currentValue: "P1" },
      })).resolves.toBeNull();
    }
  });

  it("returns null for a node-only field event when the definition has no node id", async () => {
    const event = { ...added, issueField: { id: "IF_priority", name: "Priority" } };
    const { fetchImpl } = fixture(timeline([event]));
    const transport = createGitHubIntakeApprovalTransport({
      token: "fixture-token",
      fetchImpl: async (url, init) => String(url).endsWith("/orgs/example-org/issue-fields?per_page=100")
        ? Response.json([{ id: 91, name: "Priority", options: [{ name: "P2" }] }])
        : fetchImpl(url, init),
    });
    await expect(transport.readBackFieldWrite("example-org/example-repo", 42, requested)).resolves.toBeNull();
  });

  it("skips a same-named field with a different database id beside a valid new event", async () => {
    const other = { ...added, id: "IFAE_other", issueField: {
      id: "IF_other", fullDatabaseId: "999", name: "Priority",
    } };
    await expect(fixture(timeline([other, added])).transport.readBackFieldWrite("example-org/example-repo", 42, requested))
      .resolves.toMatchObject({ eventId: added.id, eventCreatedAt, writeStartedAt });
  });

  it.each([
    { name: "no events", nodes: [] },
    { name: "a human actor", nodes: [{ ...added, actor: { login: "human" } }] },
    { name: "no actor", nodes: [{ ...added, actor: null }] },
    { name: "a different value", nodes: [{ ...added, options: [{ name: "P1" }] }] },
    { name: "a different field name", nodes: [{ ...added, issueField: { ...added.issueField, name: "Effort" } }] },
    { name: "a different field database id", nodes: [{ ...added, issueField: { ...added.issueField, fullDatabaseId: "999" } }] },
    { name: "a different known field node id", nodes: [{ ...added, issueField: { ...added.issueField, id: "IF_other" } }] },
    { name: "two matching events", nodes: [added, { ...added, id: "IFAE_duplicate" }] },
    { name: "a second new event with a different value", nodes: [added, { ...added, id: "IFAE_human", options: [{ name: "P1" }] }] },
    { name: "a second new event with a different actor", nodes: [added, { ...added, id: "IFAE_human", actor: { login: "human" } }] },
    { name: "100 nodes with just one match", nodes: [added, ...Array.from({ length: 99 }, (_, index) => ({
      ...added, id: `IFAE_old_${index}`, createdAt: "2026-10-05T12:00:00Z",
    }))] },
    { name: "an opaque node beside a match", nodes: [added, null] },
    { name: "an invalid date", nodes: [{ ...added, createdAt: "invalid" }] },
    { name: "a missing event id", nodes: [{ ...added, id: null }] },
    { name: "an empty event id", nodes: [{ ...added, id: " " }] },
    { name: "malformed options", nodes: [{ ...added, options: [{}] }] },
    { name: "conflicting value representations", nodes: [{ ...added, value: "P1" }] },
  ])("returns null for $name", async ({ nodes }) => {
    await expect(fixture(timeline(nodes)).transport.readBackFieldWrite("example-org/example-repo", 42, requested)).resolves.toBeNull();
  });

  it.each([
    { name: "GraphQL errors with partial data", payload: { ...timeline([added]), errors: [{ message: "unavailable" }] } },
    { name: "missing repository", payload: { data: { repository: null } } },
    { name: "non-array nodes", payload: { data: { repository: { issue: { timelineItems: { nodes: {} } } } } } },
    { name: "invalid JSON", payload: new Response("not JSON") },
    { name: "HTTP error", payload: new Response("unavailable", { status: 503 }) },
    { name: "network rejection", payload: new Error("network unavailable") },
  ])("never throws on $name", async ({ payload }) => {
    await expect(fixture(payload).transport.readBackFieldWrite("example-org/example-repo", 42, requested)).resolves.toBeNull();
  });

  it.each([-5000, -1000, 0, 250, 1000, 5000])("does not certify an earlier same-login no-op event at clock offset %s", async offset => {
    const event = { ...added, createdAt: "2026-10-06T11:59:58Z" };
    const { transport } = fixture(timeline([event]));
    const before = await transport.snapshotFieldEvents("example-org/example-repo", 42, "Priority");
    expect(before).toEqual({ eventIds: new Set([event.id]), currentValue: "P2" });
    await expect(transport.readBackFieldWrite("example-org/example-repo", 42, {
      ...requested, snapshot: before, writeStartedAt: new Date(Date.parse(writeStartedAt) + offset).toISOString(),
    })).resolves.toBeNull();
  });

  it.each([250, 1000, 5000])("certifies a new second-precision event despite a local clock offset of %s", async offset => {
    const event = { ...added, createdAt: "2026-10-06T12:00:00Z" };
    const start = new Date(Date.parse(writeStartedAt) + offset).toISOString();
    await expect(fixture(timeline([event])).transport.readBackFieldWrite("example-org/example-repo", 42, {
      ...requested, writeStartedAt: start,
    })).resolves.toMatchObject({ eventId: event.id, eventCreatedAt: event.createdAt, writeStartedAt: start });
  });

  it("uses the latest field event value and separates Priority from Effort", async () => {
    const priorityChange = { ...changed, id: "IFCE_priority", issueField: added.issueField,
      newOptions: [{ name: "P1" }], previousOptions: [{ name: "P2" }] };
    const { transport } = fixture(timeline([added, priorityChange, changed]));
    await expect(transport.snapshotFieldEvents("example-org/example-repo", 42, "Priority"))
      .resolves.toEqual({ eventIds: new Set([added.id, priorityChange.id]), currentValue: "P1" });
    await expect(transport.snapshotFieldEvents("example-org/example-repo", 42, "Effort"))
      .resolves.toEqual({ eventIds: new Set([changed.id]), currentValue: "Medium" });
  });

  it("does not certify an old event even when the snapshot value differs", async () => {
    await expect(fixture().transport.readBackFieldWrite("example-org/example-repo", 42, {
      ...requested, snapshot: { eventIds: new Set([added.id]), currentValue: "P1" },
    })).resolves.toBeNull();
  });

  it("does not certify a new event when the pre-write value already matched", async () => {
    await expect(fixture().transport.readBackFieldWrite("example-org/example-repo", 42, {
      ...requested, snapshot: { eventIds: new Set<string>(), currentValue: "P2" },
    })).resolves.toBeNull();
  });

  it.each([
    { name: "an empty timeline", payload: timeline([]), expected: snapshot },
    { name: "a full page", payload: timeline(Array.from({ length: 100 }, (_, i) => ({ ...added, id: `event-${i}` }))), expected: null },
    { name: "a failed request", payload: new Error("unavailable"), expected: null },
    { name: "partial GraphQL data", payload: { ...timeline([added]), errors: [{ message: "unavailable" }] }, expected: null },
    { name: "malformed values", payload: timeline([{ ...added, options: [{}] }]), expected: null },
  ])("snapshots fail closed for $name", async ({ payload, expected }) => {
    await expect(fixture(payload).transport.snapshotFieldEvents("example-org/example-repo", 42, "Priority")).resolves.toEqual(expected);
  });

  it("does not certify without a snapshot", async () => {
    await expect(fixture().transport.readBackFieldWrite("example-org/example-repo", 42, { ...requested, snapshot: null })).resolves.toBeNull();
  });

  it.each([{}, { data: { viewer: null } }, { data: { viewer: { login: "" } } },
    { data: { viewer: { login: "filing-bot" } }, errors: [{ message: "unavailable" }] }])(
    "returns null when viewer login is unavailable: %j", async viewer => {
      const { transport, fetchImpl } = fixture(timeline([added]), viewer);
      await expect(transport.readBackFieldWrite("example-org/example-repo", 42, requested)).resolves.toBeNull();
      await expect(transport.readBackFieldWrite("example-org/example-repo", 42, requested)).resolves.toBeNull();
      expect(fetchImpl.mock.calls.filter(([, init]) => /viewer\s*\{/.test(String(init?.body)))).toHaveLength(1);
    },
  );
});

describe("GitHub intake approval transport", () => {
  it("supports a fenced completed close through the issue PATCH endpoint", async () => {
    const { calls, fetchImpl } = fetchStubReturning({ number: 42, state: "closed" });
    const transport = createGitHubIntakeApprovalTransport({ token: "operator-token", fetchImpl });
    const fence = vi.fn();
    expect(transport.supportsCloseIssue).toBe(true);
    await transport.closeIssue("example-org/example-repo", 42, fence);
    expect(fence).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
    expect(String(calls[0].input)).toBe("https://api.github.com/repos/example-org/example-repo/issues/42");
    expect(calls[0].init?.method).toBe("PATCH");
    expect(JSON.parse(calls[0].init!.body as string)).toEqual({ state: "closed", state_reason: "completed" });
  });
  it.each([
    { number: 43, state: "closed" },
    { number: 42, state: "open" },
  ])("rejects a close response that did not confirm the requested close: %j", async payload => {
    const { calls, fetchImpl } = fetchStubReturning(payload);
    const transport = createGitHubIntakeApprovalTransport({ token: "operator-token", fetchImpl });
    const fence = vi.fn();
    await expect(transport.closeIssue("example-org/example-repo", 42, fence)).rejects.toThrow("did not confirm");
    expect(fence).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
    expect(String(calls[0].input)).toBe("https://api.github.com/repos/example-org/example-repo/issues/42");
    expect(calls[0].init?.method).toBe("PATCH");
  });

  it("fetches one issue with byte-exact GET headers and retains the read receipt", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ number: 42, id: 123, node_id: "I_42",
      body: "verbatim\r\nbody", html_url: "https://github.com/Owner/repo/issues/42", created_at: "2026-09-01T00:00:00Z" }),
    { headers: { "x-github-request-id": "REQ-42" } }));
    const transport = createGitHubIntakeApprovalTransport({ token: "operator-token", fetchImpl });
    const issue = await transport.fetchIssue("Owner/repo", 42);
    expect(issue).toEqual({ number: 42, id: 123, nodeId: "I_42", body: "verbatim\r\nbody", isPullRequest: false,
      htmlUrl: "https://github.com/Owner/repo/issues/42", createdAt: "2026-09-01T00:00:00Z",
      requestId: "REQ-42", fetchedAt: expect.any(String), typeName: null });
    expect(Number.isFinite(Date.parse(issue.fetchedAt))).toBe(true);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith("https://api.github.com/repos/Owner/repo/issues/42", {
      method: "GET", headers: { Authorization: "Bearer operator-token", Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": CANONICAL_REST_API_VERSION },
    });
  });

  it.each([false, true])("observes both field-value pages to exhaustion and compares actual drift (drift=%s)", async (drift) => {
    const endpoint = "https://api.github.com/repos/Owner/repo/issues/42/issue-field-values?per_page=100";
    const fieldsEndpoint = "https://api.github.com/orgs/Owner/issue-fields?per_page=100";
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.method).toBe("GET");
      const url = String(input);
      if (url === fieldsEndpoint) return Response.json([
        { id: 91, name: "Priority", options: [{ id: "P2", name: "P2" }] },
        { id: 92, name: "Effort", options: [{ id: "Low", name: "Low" }, { id: "High", name: "High" }] },
      ]);
      if (url === endpoint) return Response.json([
        ...Array.from({ length: 99 }, (_, index) => ({ issue_field_id: 1000 + index, single_select_option: null })),
        { issue_field_id: 91, single_select_option: { id: "P2" } },
      ], { headers: { link: `<${endpoint}&page=2>; rel="next", <${endpoint}&page=2>; rel="last"` } });
      if (url === `${endpoint}&page=2`) return Response.json([
        { issue_field_id: 92, single_select_option: { id: drift ? "High" : "Low" } },
      ], { headers: { link: `<${endpoint}>; rel="prev", <${endpoint}>; rel="first"` } });
      throw new Error(`Unexpected request ${url}`);
    });
    const transport = createGitHubIntakeApprovalTransport({ token: "operator-token", fetchImpl });
    const observed = await transport.readClassifications("Owner/repo", 42, {
      number: 42, id: 123, nodeId: "I_42", body: "", isPullRequest: false, typeName: "Bug",
      htmlUrl: "https://github.com/Owner/repo/issues/42", createdAt: "2026-09-01T00:00:00Z", fetchedAt: "2026-09-16T00:00:00Z",
    });
    const requested = [{ fieldName: "Type", value: "Bug" }, { fieldName: "Priority", value: "P2" }, { fieldName: "Effort", value: "Low" }] as const;
    expect(observed).toEqual([{ fieldName: "Type", value: "Bug" }, { fieldName: "Priority", value: "P2" },
      { fieldName: "Effort", value: drift ? "High" : "Low" }]);
    expect(compareLegacyClassification(requested, observed)).toEqual({ requested, observed, matches: !drift,
      drift: drift ? [{ fieldName: "Effort", requested: "Low", observed: "High" }] : [] });
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([fieldsEndpoint, endpoint, `${endpoint}&page=2`]);
  });

  it.each([404, 503])("retains fetchIssue HTTP status %s without retry", async (status) => {
    const stub = fetchStubReturning({ message: "Unavailable" }, status);
    await expect(createGitHubIntakeApprovalTransport({ token: "token", fetchImpl: stub.fetchImpl }).fetchIssue("Owner/repo", 42))
      .rejects.toMatchObject({ status });
    expect(stub.calls).toHaveLength(1);
  });

  it("detects pull_request presence and normalizes a null body", async () => {
    const stub = fetchStubReturning({ number: 42, id: 123, node_id: "I_42", body: null, pull_request: null,
      html_url: "https://github.com/Owner/repo/pull/42", created_at: "2026-09-01T00:00:00Z" });
    expect(await createGitHubIntakeApprovalTransport({ token: "token", fetchImpl: stub.fetchImpl }).fetchIssue("Owner/repo", 42))
      .toMatchObject({ isPullRequest: true, body: "" });
  });

  it("fences after held field definitions and dispatches zero mutations when the owner token changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "roadmap-transport-fence-"));
    const claim = acquireExecutionClaim(join(root, "journal.jsonl"), { mode: "execute" });
    const ownerPath = join(root, "execution.lock", "owner.json");
    let enter!: () => void;
    let resume!: (response: Response) => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const definitions = new Promise<Response>((resolve) => { resume = resolve; });
    const mutations: string[] = [];
    const transport = createGitHubIntakeApprovalTransport({ token: "test-token", fetchImpl: async (url, init) => {
      if (init?.method === "GET") {
        enter();
        return definitions;
      }
      mutations.push(`${init?.method} ${url}`);
      return new Response("", { status: 200 });
    } });
    const fence = vi.fn(() => claim.withOwnership(() => {}));
    try {
      const running = transport.applyClassification("example-org/example-repo", 42,
        { fieldName: "Priority", value: "P1" }, fence);
      await entered;
      expect(fence).not.toHaveBeenCalled(); // The definition GET is never fenced.
      const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
      writeFileSync(ownerPath, JSON.stringify({ ...owner, token: "b".repeat(32) }));
      const successorBytes = readFileSync(ownerPath);
      resume(new Response(JSON.stringify({ issue_fields: [{
        id: 91, name: "Priority", options: [{ name: "P1" }],
      }] })));
      await expect(running).rejects.toThrow(ExecutionOwnershipError);
      expect(fence).toHaveBeenCalledOnce();
      expect(mutations).toEqual([]);
      expect(readFileSync(ownerPath)).toEqual(successorBytes);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["create", "comment", "Type", "Priority", "Effort"])("fences the %s HTTP mutation synchronously at fetch", async (site) => {
    const order: string[] = [];
    const fence = () => {
      order.push("fence");
      queueMicrotask(() => order.push("microtask"));
    };
    const transport = createGitHubIntakeApprovalTransport({ token: "test-token", fetchImpl: async (_url, init) => {
      order.push(init?.method ?? "GET");
      if (init?.method === "GET") return new Response(JSON.stringify({ issue_fields: [
        { id: 91, name: "Priority", options: [{ name: "P1" }] },
        { id: 92, name: "Effort", options: [{ name: "Medium" }] },
      ] }));
      return new Response(JSON.stringify({ number: 42, node_id: "I_42", id: 9001 }));
    } });
    if (site === "create") await transport.createIssue("example-org/example-repo", { title: "Title", body: "Body" }, fence);
    else if (site === "comment") await transport.appendEvidenceComment("example-org/example-repo", 42, "Evidence", fence);
    else await transport.applyClassification("example-org/example-repo", 42, {
      fieldName: site as "Type" | "Priority" | "Effort", value: site === "Type" ? "Task" : site === "Priority" ? "P1" : "Medium",
    }, fence);
    expect(order).toEqual([
      ...(["Priority", "Effort"].includes(site) ? ["GET"] : []),
      "fence", site === "Type" ? "PATCH" : "POST", "microtask",
    ]);
  });

  it.each(["create", "comment", "Type", "Priority", "Effort", "close"])("sends zero mutating fetches for %s when the fence refuses", async (site) => {
    const calls: string[] = [];
    const fence = vi.fn(() => { throw new Error("ownership lost"); });
    const transport = createGitHubIntakeApprovalTransport({ token: "test-token", fetchImpl: async (_url, init) => {
      calls.push(init?.method ?? "GET");
      return new Response(JSON.stringify({ issue_fields: [
        { id: 91, name: "Priority", options: [{ name: "P1" }] },
        { id: 92, name: "Effort", options: [{ name: "Medium" }] },
      ] }));
    } });
    const running = site === "create" ? transport.createIssue("example-org/example-repo", { title: "Title", body: "Body" }, fence)
      : site === "comment" ? transport.appendEvidenceComment("example-org/example-repo", 42, "Evidence", fence)
      : site === "close" ? transport.closeIssue("example-org/example-repo", 42, fence)
      : transport.applyClassification("example-org/example-repo", 42, {
        fieldName: site as "Type" | "Priority" | "Effort", value: site === "Type" ? "Task" : site === "Priority" ? "P1" : "Medium",
      }, fence);
    await expect(running).rejects.toThrow("ownership lost");
    expect(calls.filter((method) => method !== "GET")).toEqual([]);
    expect(fence).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects create response number %s at the concrete transport boundary",
    async (number) => {
      const stub = fetchStubReturning({ number, node_id: "I_landed" }, 201);
      const transport = createGitHubIntakeApprovalTransport({ token: "operator-token", fetchImpl: stub.fetchImpl });
      await expect(transport.createIssue("example-org/example-repo", { title: "Title", body: "Body" }))
        .rejects.toThrow(/number/);
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0].init?.method).toBe("POST");
    },
  );
  it("creates an issue with the pinned GitHub contract and returns its identifiers", async () => {
    const stub = fetchStubReturning({ number: 42, node_id: "I_kwDOExample" }, 201);
    const transport = createGitHubIntakeApprovalTransport({
      token: "operator-token",
      fetchImpl: stub.fetchImpl,
    });

    await expect(transport.createIssue("example-org/example-repo", {
      title: "Approved roadmap outcome",
      body: "Bound evidence",
    })).resolves.toEqual({ issueNumber: 42, issueId: "I_kwDOExample" });

    expect(stub.calls).toHaveLength(1);
    const { input, init } = stub.calls[0];
    expect(input).toBe("https://api.github.com/repos/example-org/example-repo/issues");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer operator-token");
    expect(headers.get("Accept")).toBe("application/vnd.github+json");
    expect(headers.get("X-GitHub-Api-Version")).toBe(CANONICAL_REST_API_VERSION);
    expect(JSON.parse(String(init?.body))).toEqual({
      title: "Approved roadmap outcome",
      body: "Bound evidence",
    });
  });

  it("appends evidence to the requested issue", async () => {
    const stub = fetchStubReturning({ id: 9001 }, 201);
    const transport = createGitHubIntakeApprovalTransport({
      token: "operator-token",
      fetchImpl: stub.fetchImpl,
    });

    await expect(transport.appendEvidenceComment(
      "example-org/example-repo",
      73,
      "Evidence comment",
    )).resolves.toEqual({ commentId: 9001 });

    const { input, init } = stub.calls[0];
    expect(input).toBe("https://api.github.com/repos/example-org/example-repo/issues/73/comments");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ body: "Evidence comment" });
  });

  it("throws the status and response body for a non-2xx response", async () => {
    const fetchImpl = async (): Promise<Response> => new Response("validation failed", { status: 422 });
    const transport = createGitHubIntakeApprovalTransport({
      token: "operator-token",
      fetchImpl,
    });

    await expect(transport.createIssue("example-org/example-repo", {
      title: "Title",
      body: "Body",
    })).rejects.toThrow("GitHub request failed with status 422: validation failed");
  });

  it.each(["create", "classification", "read-back"])("redacts and caps the error response body for %s without changing the request", async (site) => {
    const token = "credential-to-redact";
    const body = `${token} / ${token}: ${"x".repeat(600)} tail`;
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(body, { status: 422 }));
    const transport = createGitHubIntakeApprovalTransport({ token, fetchImpl });
    const operation = site === "create" ? transport.createIssue("example-org/example-repo", { title: "Title", body: "Body" })
      : site === "classification" ? transport.applyClassification("example-org/example-repo", 42, { fieldName: "Type", value: "Task" })
        : transport.verifyClassifications("example-org/example-repo", 42, [{ fieldName: "Type", value: "Task" }]);
    const error = await operation.catch((cause: unknown) => cause) as Error;
    expect(error).toMatchObject({ status: 422, message: `GitHub request failed with status 422: ${body.replaceAll(token, "[redacted]").slice(0, 512)}` });
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain(token);
    expect(error.message).not.toContain("tail");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get("Authorization")).toBe(`Bearer ${token}`);
  });

  it.each(["fetch rejection", "body rejection", "invalid JSON", "live option"])("redacts credentials in %s diagnostics", async (site) => {
    const token = "credential-to-redact";
    const fetchImpl = vi.fn(async () => {
      if (site === "fetch rejection") throw new Error(`Network rejected ${token}`);
      if (site === "body rejection") return Object.assign(new Response(), { text: async () => { throw new Error(`Body rejected ${token}`); } });
      if (site === "invalid JSON") return new Response(token);
      return new Response(JSON.stringify({ issue_fields: [{ id: 91, name: "Priority", options: [{ name: token }] }] }));
    });
    const transport = createGitHubIntakeApprovalTransport({ token, fetchImpl });
    const operation = site === "live option"
      ? transport.applyClassification("example-org/example-repo", 42, { fieldName: "Priority", value: "P1" })
      : transport.fetchIssue("example-org/example-repo", 42);
    const error = await operation.catch((cause: unknown) => cause) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain(token);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each(["create", "classification", "read-back"])("carries HTTP status on a rejected %s request", async (site) => {
    const transport = createGitHubIntakeApprovalTransport({ token: "operator-token",
      fetchImpl: async () => new Response("validation failed", { status: 422 }) });
    const operation = site === "create" ? transport.createIssue("example-org/example-repo", { title: "Title", body: "Body" })
      : site === "classification" ? transport.applyClassification("example-org/example-repo", 42, { fieldName: "Type", value: "Task" })
        : transport.verifyClassifications("example-org/example-repo", 42, [{ fieldName: "Type", value: "Task" }]);
    await expect(operation).rejects.toMatchObject({ status: 422, message: "GitHub request failed with status 422: validation failed" });
  });

  it.each(["create", "classification", "read-back"])("carries null status and the original cause when %s fetch rejects", async (site) => {
    const cause = new TypeError("fetch failed");
    const transport = createGitHubIntakeApprovalTransport({ token: "operator-token",
      fetchImpl: async () => { throw cause; } });
    const operation = site === "create" ? transport.createIssue("example-org/example-repo", { title: "Title", body: "Body" })
      : site === "classification" ? transport.applyClassification("example-org/example-repo", 42, { fieldName: "Type", value: "Task" })
        : transport.verifyClassifications("example-org/example-repo", 42, [{ fieldName: "Type", value: "Task" }]);
    const error: unknown = await operation.catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ status: null, message: "fetch failed" });
    expect((error as Error).cause).toBe(cause);
  });

  it("retries field definitions after a failed GET and proceeds on the second attempt", async () => {
    let definitionsAttempts = 0;
    const calls: { readonly input: string; readonly method: string }[] = [];
    const transport = createGitHubIntakeApprovalTransport({
      token: "operator-token",
      fetchImpl: async (input, init) => {
        calls.push({ input: String(input), method: init?.method ?? "GET" });
        if ((init?.method ?? "GET") === "GET") {
          definitionsAttempts += 1;
          if (definitionsAttempts === 1) return new Response("temporary failure", { status: 503 });
          return new Response(JSON.stringify({ issue_fields: [{
            id: 91, name: "Priority", options: [{ name: "P1" }],
          }] }), { status: 200 });
        }
        return new Response("", { status: 200 });
      },
    });

    await expect(transport.applyClassification("example-org/example-repo", 42, {
      fieldName: "Priority", value: "P1",
    })).rejects.toThrow(/status 503/);
    await expect(transport.applyClassification("example-org/example-repo", 42, {
      fieldName: "Priority", value: "P1",
    })).resolves.toEqual({});

    expect(definitionsAttempts).toBe(2);
    expect(calls.map(({ method }) => method)).toEqual(["GET", "GET", "POST"]);
  });

  it("treats a successful classification response with an empty body as success", async () => {
    const transport = createGitHubIntakeApprovalTransport({
      token: "operator-token",
      fetchImpl: async () => new Response("", { status: 200 }),
    });

    await expect(transport.applyClassification("example-org/example-repo", 42, {
      fieldName: "Type", value: "Task",
    })).resolves.toEqual({});
  });

  it("reads native Type and issue field option ids to verify classifications", async () => {
    const calls: Array<{ input: string; method: string }> = [];
    const transport = createGitHubIntakeApprovalTransport({
      token: "operator-token",
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push({ input: url, method: init?.method ?? "GET" });
        if (url.endsWith("/issues/42")) {
          return new Response(JSON.stringify({ type: { name: "Task" } }), { status: 200 });
        }
        if (url.includes("/orgs/example-org/issue-fields")) {
          return new Response(JSON.stringify({ issue_fields: [
            { id: 91, name: "Priority", options: [{ id: "PVTSSF_P1", name: "P1" }] },
            { id: 92, name: "Effort", options: [{ id: "PVTSSF_MEDIUM", name: "Medium" }] },
          ] }), { status: 200 });
        }
        return new Response(JSON.stringify([
          { issue_field_id: 91, single_select_option: { id: "PVTSSF_P1", name: "P1" } },
          { issue_field_id: 92, single_select_option: { id: "PVTSSF_MEDIUM", name: "Medium" } },
        ]), { status: 200 });
      },
    });

    await expect(transport.verifyClassifications("example-org/example-repo", 42, [
      { fieldName: "Type", value: "Task" },
      { fieldName: "Priority", value: "P1" },
      { fieldName: "Effort", value: "Medium" },
    ])).resolves.toBe(true);
    expect(calls).toEqual([
      { input: "https://api.github.com/repos/example-org/example-repo/issues/42", method: "GET" },
      { input: "https://api.github.com/orgs/example-org/issue-fields?per_page=100", method: "GET" },
      { input: "https://api.github.com/repos/example-org/example-repo/issues/42/issue-field-values?per_page=100", method: "GET" },
    ]);
  });

  it.each([
    {
      name: "wrong native Type",
      classifications: [{ fieldName: "Type" as const, value: "Task" }],
      issue: { type: { name: "Bug" } },
      fields: { issue_fields: [] },
      values: [],
    },
    {
      name: "missing native Type",
      classifications: [{ fieldName: "Type" as const, value: "Task" }],
      issue: { type: null },
      fields: { issue_fields: [] },
      values: [],
    },
    {
      name: "missing field definition",
      classifications: [{ fieldName: "Priority" as const, value: "P1" }],
      issue: { type: { name: "Task" } },
      fields: { issue_fields: [] },
      values: [{ issue_field_id: 91, single_select_option: { id: "PVTSSF_P1", name: "P1" } }],
    },
    {
      name: "missing option",
      classifications: [{ fieldName: "Priority" as const, value: "P1" }],
      issue: { type: { name: "Task" } },
      fields: { issue_fields: [{ id: 91, name: "Priority", options: [] }] },
      values: [{ issue_field_id: 91, single_select_option: { id: "PVTSSF_P1", name: "P1" } }],
    },
    {
      name: "missing value row",
      classifications: [{ fieldName: "Priority" as const, value: "P1" }],
      issue: { type: { name: "Task" } },
      fields: { issue_fields: [{ id: 91, name: "Priority", options: [{ id: "PVTSSF_P1", name: "P1" }] }] },
      values: [],
    },
    {
      name: "wrong issue_field_id",
      classifications: [{ fieldName: "Priority" as const, value: "P1" }],
      issue: { type: { name: "Task" } },
      fields: { issue_fields: [{ id: 91, name: "Priority", options: [{ id: "PVTSSF_P1", name: "P1" }] }] },
      values: [{ issue_field_id: 92, single_select_option: { id: "PVTSSF_P1", name: "P1" } }],
    },
    {
      name: "wrong single_select_option.id",
      classifications: [{ fieldName: "Priority" as const, value: "P1" }],
      issue: { type: { name: "Task" } },
      fields: { issue_fields: [{ id: 91, name: "Priority", options: [{ id: "PVTSSF_P1", name: "P1" }] }] },
      values: [{ issue_field_id: 91, single_select_option: { id: "PVTSSF_P2", name: "P2" } }],
    },
    {
      name: "selected option id/name divergence",
      classifications: [{ fieldName: "Priority" as const, value: "P1" }],
      issue: { type: { name: "Task" } },
      fields: { issue_fields: [{ id: 91, name: "Priority", options: [{ id: "PVTSSF_P1", name: "P1" }] }] },
      values: [{ issue_field_id: 91, single_select_option: { id: "PVTSSF_P2", name: "P1" } }],
    },
  ])("returns false for $name", async ({ classifications, issue, fields, values }) => {
    const transport = createGitHubIntakeApprovalTransport({
      token: "operator-token",
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/issues/42")) return new Response(JSON.stringify(issue), { status: 200 });
        if (url.includes("/orgs/example-org/issue-fields")) {
          return new Response(JSON.stringify(fields), { status: 200 });
        }
        return new Response(JSON.stringify(values), { status: 200 });
      },
    });

    await expect(transport.verifyClassifications(
      "example-org/example-repo", 42, classifications,
    )).resolves.toBe(false);
  });

  it.each([
    {
      name: "malformed response body",
      response: () => new Response("not json", { status: 200 }),
      error: /invalid JSON/i,
    },
    {
      name: "request failure",
      response: () => new Response("service unavailable", { status: 503 }),
      error: /status 503.*service unavailable/i,
    },
  ])("rejects verification on $name", async ({ response, error }) => {
    const transport = createGitHubIntakeApprovalTransport({
      token: "operator-token",
      fetchImpl: async () => response(),
    });

    await expect(transport.verifyClassifications("example-org/example-repo", 42, [
      { fieldName: "Type", value: "Task" },
    ])).rejects.toThrow(error);
  });

  it("treats an intentional empty classification request as verified without HTTP", async () => {
    const calls: string[] = [];
    const transport = createGitHubIntakeApprovalTransport({
      token: "operator-token",
      fetchImpl: async (input) => {
        calls.push(String(input));
        throw new Error("unexpected request");
      },
    });

    await expect(transport.verifyClassifications("example-org/example-repo", 42, [])).resolves.toBe(true);
    expect(calls).toEqual([]);
  });

  it("rejects malformed repository names before issuing a request", async () => {
    const stub = fetchStubReturning({ number: 42, node_id: "I_kwDOExample" }, 201);
    const transport = createGitHubIntakeApprovalTransport({
      token: "operator-token",
      fetchImpl: stub.fetchImpl,
    });

    await expect(transport.createIssue("example-org/example-repo/extra", {
      title: "Title",
      body: "Body",
    })).rejects.toThrow(/exactly one non-empty owner\/name pair/i);
    expect(stub.calls).toHaveLength(0);
  });

  it("explicitly refuses Horizon classification", async () => {
    const transport = createGitHubIntakeApprovalTransport({
      token: "operator-token",
      fetchImpl: fetchStubReturning({}, 200).fetchImpl,
    });

    await expect(transport.applyClassification("example-org/example-repo", 42, {
      fieldName: "Horizon",
      value: "Now",
    } as never)).rejects.toThrow(/structurally forbids writing a Horizon classification/i);
  });

  it("rejects empty and whitespace-only tokens at construction", () => {
    expect(() => createGitHubIntakeApprovalTransport({ token: "" })).toThrow(/non-empty token/i);
    expect(() => createGitHubIntakeApprovalTransport({ token: "   " })).toThrow(/non-empty token/i);
  });
});
