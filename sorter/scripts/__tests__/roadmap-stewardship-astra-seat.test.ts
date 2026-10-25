import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve, join, sep } from "node:path";
import {
  checkStewardshipAstraStartup, createStewardshipAstraSeat, STEWARDSHIP_ASTRA_CODEX_HOME,
  type StewardshipAstraSeatDependencies, type StewardshipAstraStartupCheck,
} from "../lib/github-issue-roadmap/stewardship-astra-seat";
import { STEWARDSHIP_ASTRA_BIN_DIRECTORY, STEWARDSHIP_ASTRA_EXECUTABLE_RELATIVE, STEWARDSHIP_ASTRA_PIN } from "../lib/github-issue-roadmap/stewardship-astra-seat-pin";
import { StewardshipAssessmentError, stewardshipDiagnostic } from "../lib/github-issue-roadmap/stewardship-diagnostics";
import { assessStewardshipIssue, StewardshipSeatRequalifyRequired, type StewardshipSeat } from "../lib/github-issue-roadmap/stewardship-assessment";
import { ASSESSMENT_OUTPUT_BYTES, openStewardshipSeatSession, type StewardshipSeatSession } from "../lib/github-issue-roadmap/stewardship-seat-process";
import { assessmentFixture, evidenceFixture, now, policy } from "./fixtures/roadmap-stewardship";

const PIN = "FDDA5FA3CF3FB3D000B876720742857676293E4315E4B045FAE6F8BD7E866D1D";
vi.mock("../lib/github-issue-roadmap/stewardship-astra-seat-pin", async (original) => {
  const actual = await original<typeof import("../lib/github-issue-roadmap/stewardship-astra-seat-pin")>();
  return { ...actual, STEWARDSHIP_ASTRA_PIN: { ...actual.STEWARDSHIP_ASTRA_PIN } };
});
const originalPin = { ...STEWARDSHIP_ASTRA_PIN };
const binaryFixtureRoots: string[] = [];
// Independent fixture for the qualified feature set: changing production must not silently change the oracle.
const FEATURES = [
  "apps", "plugins", "remote_plugin", "hooks", "shell_tool", "unified_exec", "shell_snapshot",
  "code_mode", "code_mode_host", "browser_use", "browser_use_external", "computer_use",
  "image_generation", "multi_agent", "multi_agent_v2", "view_image", "goals", "sleep_tool",
  "memories", "workspace_dependencies", "skill_search", "skill_mcp_dependency_install",
  "tool_suggest", "in_app_browser", "in_app_local_automation", "browser_use_full_cdp_access",
  "unified_exec_tty", "worktrees", "realtime_conversation",
];
const PRIVATE = "private-account-config-server-sentinel";
const failure = (code = "seat_unavailable") => ({ detail: { stage: "startup", code, field: "$" } });
const ANSWER = { verdict: "retain", reason: "Evidence supports the current state." };
const success = { assessment: ANSWER, observedModel: "configured:gpt-6-astra" };
const notification = (method: string, params: Record<string, unknown> = {}) => ({ method, params });
const itemEvent = (type: string, method = "item/completed", extra: Record<string, unknown> = {}) => notification(method, {
  threadId: "thread-1", turnId: "turn-1", item: { id: "answer-1", type, ...extra },
});
const finalAnswer = (text = JSON.stringify(ANSWER), extra: Record<string, unknown> = {}) => itemEvent("agentMessage", "item/completed", { text, phase: "final_answer", ...extra });
const turnComplete = (status: unknown = "completed") => notification("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status } });
const MODERATION_SENTINEL = "private-moderation-metadata-sentinel";
const moderationMetadata = (overrides: Record<string, unknown> = {}) => notification("turn/moderationMetadata", {
  threadId: "thread-1", turnId: "turn-1", metadata: { sentinel: MODERATION_SENTINEL }, ...overrides,
});

afterEach(() => {
  Object.assign(STEWARDSHIP_ASTRA_PIN, originalPin);
  vi.unstubAllEnvs(); vi.useRealTimers();
  for (const root of binaryFixtureRoots.splice(0)) {
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}astra-binary-test-`)) throw new Error("Unsafe binary fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

function globalBinaryFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "astra-binary-test-")); binaryFixtureRoots.push(root);
  vi.stubEnv("APPDATA", root);
  const global = join(root, "npm", "node_modules", "@openai", "codex", "node_modules", "@openai",
    "codex-win32-x64", STEWARDSHIP_ASTRA_EXECUTABLE_RELATIVE);
  mkdirSync(dirname(global), { recursive: true }); writeFileSync(global, "updated global binary 0.162.1");
  return global;
}

it("resolves only the vendored path while the global npm path contains a different binary", async () => {
  const global = globalBinaryFixture(); const h = harness();
  const vendored = join(STEWARDSHIP_ASTRA_BIN_DIRECTORY, STEWARDSHIP_ASTRA_EXECUTABLE_RELATIVE);
  h.readExecutableHash.mockImplementation(async (path) => path === vendored ? PIN
    : createHash("sha256").update(readFileSync(path)).digest("hex"));
  await expect(checkStewardshipAstraStartup({ ...h.dependencies, executablePath: undefined })).resolves.toEqual({ ok: true });
  expect(h.readExecutableHash.mock.calls.map(([path]) => path)).toEqual([vendored]);
  expect(h.readExecutableHash).not.toHaveBeenCalledWith(global, expect.anything());
  expect(h.sessionFactory.mock.calls[0][0].command).toBe(vendored);
});

it("reports executable_missing without falling back to an updated global binary", async () => {
  const global = globalBinaryFixture(); const h = harness();
  const vendored = join(STEWARDSHIP_ASTRA_BIN_DIRECTORY, STEWARDSHIP_ASTRA_EXECUTABLE_RELATIVE);
  h.readExecutableHash.mockImplementation(async (path) => {
    if (path === vendored) throw Object.assign(new Error("missing fixture executable"), { code: "ENOENT" });
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  });
  await expect(checkStewardshipAstraStartup({ ...h.dependencies, executablePath: undefined }))
    .resolves.toEqual({ ok: false, failedCheck: "executable_missing" });
  expect(h.readExecutableHash.mock.calls.map(([path]) => path)).toEqual([vendored]);
  expect(h.readExecutableHash).not.toHaveBeenCalledWith(global, expect.anything());
  expect(h.sessionFactory).not.toHaveBeenCalled(); expect(h.dependencies.ensureCodexHome).not.toHaveBeenCalled();
});

it("reports executable_missing for an absent file and executable_hash for a present wrong binary", async () => {
  const global = globalBinaryFixture(); const h = harness();
  await expect(checkStewardshipAstraStartup({ ...h.dependencies, executablePath: join(dirname(global), "missing.exe"), readExecutableHash: undefined }))
    .resolves.toEqual({ ok: false, failedCheck: "executable_missing" });
  await expect(checkStewardshipAstraStartup({ ...h.dependencies, executablePath: global, readExecutableHash: undefined }))
    .resolves.toEqual({ ok: false, failedCheck: "executable_hash" });
  expect(h.sessionFactory).not.toHaveBeenCalled();
});

function vendoredTreeFixture() {
  const root = mkdtempSync(join(tmpdir(), "astra-binary-test-")); binaryFixtureRoots.push(root);
  const destination = join(root, "astra-seat-bin", "0.160.0");
  const executable = join(destination, STEWARDSHIP_ASTRA_EXECUTABLE_RELATIVE);
  const helper = join(destination, "vendor/x86_64-pc-windows-msvc/codex-path/rg.exe");
  const files = [["x86_64-pc-windows-msvc/bin/codex.exe", "fixture codex"], ["x86_64-pc-windows-msvc/codex-path/rg.exe", "fixture helper"]];
  for (const [name, bytes] of files) {
    const path = join(destination, "vendor", name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes);
  }
  const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex").toUpperCase();
  Object.assign(STEWARDSHIP_ASTRA_PIN, { executableSha256: hash("fixture codex"),
    treeManifestSha256: hash(files.map(([name, bytes]) => `${name} ${hash(bytes)}\n`).join("")) });
  const h = harness();
  return { root, destination, executable, helper, h, dependencies: { ...h.dependencies, executablePath: executable, readExecutableHash: undefined } };
}

it("streams and accepts the complete pinned fixture tree before opening a seat", async () => {
  const f = vendoredTreeFixture();
  await expect(checkStewardshipAstraStartup(f.dependencies)).resolves.toEqual({ ok: true });
  expect(f.h.sessionFactory).toHaveBeenCalledOnce();
});

it.each(["extra", "missing", "changed", "case"])("reports tree_hash for an %s helper file before launching", async (change) => {
  const f = vendoredTreeFixture();
  if (change === "missing") rmSync(f.helper);
  else if (change === "case") { const bytes = readFileSync(f.helper); rmSync(f.helper); writeFileSync(join(dirname(f.helper), "RG.exe"), bytes); }
  else writeFileSync(change === "extra" ? join(dirname(f.helper), "extra.exe") : f.helper, "unqualified helper");
  await expect(checkStewardshipAstraStartup(f.dependencies)).resolves.toEqual({ ok: false, failedCheck: "tree_hash" });
  expect(f.h.sessionFactory).not.toHaveBeenCalled(); expect(f.h.reserve).not.toHaveBeenCalled();
});

it.each(["missing", "changed"])("preserves executable_%s for codex.exe in a real fixture tree", async (change) => {
  const f = vendoredTreeFixture();
  if (change === "missing") rmSync(f.executable); else writeFileSync(f.executable, "unqualified codex");
  await expect(checkStewardshipAstraStartup(f.dependencies)).resolves.toEqual({ ok: false,
    failedCheck: change === "missing" ? "executable_missing" : "executable_hash" });
  expect(f.h.sessionFactory).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== "win32").each(["vendor", "ancestor", "nested"])("reports install_path for a Windows %s junction before launching", async (component) => {
  const f = vendoredTreeFixture();
  const path = component === "vendor" ? join(f.destination, "vendor")
    : component === "ancestor" ? dirname(f.destination) : dirname(f.helper);
  const outside = join(f.root, "outside"); renameSync(path, outside); symlinkSync(outside, path, "junction");
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
  await expect(checkStewardshipAstraStartup(f.dependencies)).resolves.toEqual({ ok: false, failedCheck: "install_path" });
  expect(f.h.sessionFactory).not.toHaveBeenCalled(); expect(f.h.reserve).not.toHaveBeenCalled();
  expect(readFileSync(f.helper, "utf8")).toBe("fixture helper");
});

it("H2 regression: consecutive constant payloads have independent one-message histories and flat usage", async () => {
  const h = harness(); const history = new Map<string, string[]>();
  const payloads: number[] = []; const threadIds: string[] = []; const usage = vi.fn();
  h.onReply((request) => {
    if (request.method !== "turn/start") return;
    const id = request.params.threadId as string;
    const messages = history.get(id) ?? [];
    messages.push((request.params.input as { text: string }[])[0].text); history.set(id, messages);
    threadIds.push(id); payloads.push(Buffer.byteLength(JSON.stringify({ ...request, id: "turn-request" })));
    h.setEvents(messages.length > 1 ? [notification("thread/compacted", { threadId: id })] : [
      notification("thread/tokenUsage/updated", { threadId: id, turnId: "turn-1",
        tokenUsage: { last: { inputTokens: messages.length * 100, cachedInputTokens: 0, outputTokens: 8 },
          total: { inputTokens: 9999, cachedInputTokens: 0, outputTokens: 999 } } }), finalAnswer(), turnComplete(),
    ]);
  });
  const seat = createStewardshipAstraSeat(h.dependencies); await seat.start!(60_000);
  try {
    for (let issue = 0; issue < 5; issue++) await expect(seat.invoke({ ...h.input, prompt: `issue ${issue}`, recordUsage: usage })).resolves.toEqual(success);
    expect(new Set(payloads).size).toBe(1); expect(new Set(threadIds).size).toBe(5);
    expect([...history.values()]).toEqual(Array.from({ length: 5 }, (_, issue) => [`issue ${issue}`]));
    expect(usage.mock.calls.map(([value]) => value.inputTokens)).toEqual([100, 100, 100, 100, 100]);
    expect(h.requests.filter((r) => r.method === "mcpServerStatus/list").map((r) => r.params.threadId)).toEqual(["thread-1", ...threadIds]);
    expect(h.requests.filter((r) => r.method === "thread/unsubscribe").map((r) => r.params.threadId)).toEqual(["thread-1", ...threadIds]);
    expect(h.requests.filter((r) => r.method === "thread/start").every((r) => JSON.stringify(r.params) === JSON.stringify(h.requests.find((r) => r.method === "thread/start")!.params))).toBe(true);
  } finally { await seat.close!(); }
});

it.each([500_000, 240_000])("keeps the shared seat available after a four-minute queued invoke with %s ms overall", async (timeoutMs) => {
  vi.useFakeTimers(); const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies); await seat.start!(60_000);
  let release!: () => void; let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const turnStarted = new Promise<void>((resolve) => { entered = resolve; });
  h.onReply((request) => { if (request.method === "turn/start" && request.params.threadId === "thread-2") { entered(); return held; } });
  const first = seat.invoke({ ...h.input, timeoutMs: 300_000, reserve: () => 300_000 });
  await turnStarted;
  const reserveB = vi.fn(() => 240_000);
  const second = seat.invoke({ ...h.input, timeoutMs, reserve: reserveB }).catch((error: unknown) => error);
  try {
    h.advance(240_000); release();
    await expect(first).resolves.toEqual(success);
    // Queue time is charged to neither qualification nor the turn: the reservation sets the turn budget.
    await expect(second).resolves.toEqual(success);
    expect(reserveB).toHaveBeenCalledOnce();
    expect(h.requests.filter((request) => request.method === "thread/start")).toHaveLength(3);
    expect(h.sessions[0].close).not.toHaveBeenCalled();
    await expect(seat.invoke({ ...h.input, prompt: "issue C" })).resolves.toEqual(success);
    expect(h.sessionFactory).toHaveBeenCalledOnce();
  } finally { release(); await Promise.allSettled([first, second]); await seat.close!(); }
});

it.each([true, false])("gives cleanup five seconds when a turn finishes with one millisecond left (shared=%s)", async (shared) => {
  const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies);
  if (shared) await seat.start!(60_000);
  h.onReply((request) => {
    if (request.method === "turn/start") h.advance(999);
    if (request.method === "thread/unsubscribe") h.advance(20);
  });
  try {
    await expect(seat.invoke(h.input)).resolves.toEqual(success);
    if (shared) expect(h.sessions[0].close).not.toHaveBeenCalled();
    await expect(seat.invoke(h.input)).resolves.toEqual(success);
    expect(h.sessionFactory).toHaveBeenCalledTimes(shared ? 1 : 2);
  } finally { await seat.close!(); }
});

it.each([true, false])("fails closed when thread cleanup exceeds its five-second budget (shared=%s)", async (shared) => {
  vi.useFakeTimers(); const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies);
  if (shared) await seat.start!(60_000);
  h.onReply((request) => { if (request.method === "thread/unsubscribe") return new Promise<void>(() => {}); });
  let settled = false;
  const outcome = seat.invoke(h.input).catch((error: unknown) => { settled = true; return error; });
  try {
    await vi.advanceTimersByTimeAsync(4_999); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ detail: { code: "assessment_cleanup_failed" } });
    expect(h.sessions[0].close).toHaveBeenCalledOnce();
    await expect(seat.invoke(h.input)).rejects.toMatchObject(failure());
  } finally { await seat.close!(); }
});

it.each(["qualification", "admission", "active", "cleanup"] as const)("discards a finished turn's late RPC response during %s", async (phase) => {
  const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies); await seat.start!(60_000); await seat.invoke(h.input);
  const previousId = h.requests.find((request) => request.method === "turn/start")!.id;
  const late = { id: previousId, result: { turn: { id: "previous-turn" } } };
  const method = phase === "qualification" ? "thread/start" : phase === "cleanup" ? "thread/unsubscribe" : "turn/start";
  h.onWire((request, response) => [...(phase !== "admission" && request.method === method ? [late] : []), { id: request.id, result: response }]);
  try {
    await expect(seat.invoke({ ...h.input, reserve: () => {
      if (phase === "admission") h.sessions[0].queue.push(late);
      return 1000;
    } })).resolves.toEqual(success);
    const ids = h.requests.filter((request) => request.method === "turn/start").map((request) => request.id);
    expect(new Set(ids).size).toBe(2); expect(h.sessions[0].close).not.toHaveBeenCalled();
  } finally { await seat.close!(); }
});

it.each(["unknown_id", "tool_request", "usage_limit"] as const)("keeps late RPC traffic fail closed for %s", async (kind) => {
  const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies); await seat.start!(60_000); await seat.invoke(h.input);
  const previousId = h.requests.find((request) => request.method === "turn/start")!.id;
  const late = kind === "unknown_id" ? { id: "unknown-turn-request", result: {} }
    : kind === "tool_request" ? { id: previousId, method: "item/tool/call", params: {} }
      : { id: previousId, error: { message: "HTTP 402" } };
  h.onWire((request, response) => [...(request.method === "thread/start" ? [late] : []), { id: request.id, result: response }]);
  try {
    await expect(seat.invoke(h.input)).rejects.toMatchObject(kind === "usage_limit" ? { message: "stopped_usage_limit" } : failure());
    await expect(seat.invoke(h.input)).rejects.toMatchObject(failure());
  } finally { await seat.close!(); }
});

it.each(["thread/start", "thread_model", "thread_sandbox", "inventory", "inventory_pagination"] as const)(
  "a mid-run %s failure requalifies per thread, reserves no turn and disables the seat", async (check) => {
    const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies); await seat.start!(60_000);
    await seat.invoke(h.input); h.reserve.mockClear();
    if (check === "thread_model") h.thread.model = "wrong-model";
    if (check === "thread_sandbox") h.thread.sandbox.networkAccess = true;
    if (check === "inventory") h.inventory.data = [{ name: PRIVATE }];
    if (check === "inventory_pagination") h.inventory.nextCursor = "endless";
    if (check === "thread/start") h.onWire((r, response) => r.method === "thread/start"
      ? [{ id: r.id, error: { message: PRIVATE } }] : [{ id: r.id, result: response }]);
    try {
      await expect(seat.invoke(h.input)).rejects.toMatchObject(failure());
      await expect(seat.invoke(h.input)).rejects.toMatchObject(failure());
      expect(h.reserve).not.toHaveBeenCalled(); expect(h.sessionFactory).toHaveBeenCalledOnce();
      expect(h.sessions[0].close).toHaveBeenCalledOnce();
    } finally { await seat.close!(); }
  });

it.each(["qualification", "admission", "active", "cleanup"] as const)(
  "routes safe finished-thread traffic during %s without binding its answer or usage to the next issue", async (phase) => {
    const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies); await seat.start!(60_000);
    await seat.invoke(h.input);
    const previous = h.requests.find((r) => r.method === "turn/start")!.params.threadId;
    const late = [notification("thread/closed", { threadId: previous }),
      notification("turn/completed", { threadId: previous, turn: { id: "turn-1", status: "completed" } }),
      notification("item/completed", { threadId: previous, turnId: "turn-1", item: { type: "agentMessage", id: "late-answer", text: "previous answer", phase: "final_answer" } }),
      notification("thread/tokenUsage/updated", { threadId: previous, turnId: "turn-1", tokenUsage: { last: { inputTokens: 9999 } } }),
      moderationMetadata({ threadId: previous })];
    const method = phase === "qualification" ? "thread/start" : phase === "cleanup" ? "thread/unsubscribe" : "turn/start";
    h.onWire((r, response) => [...(phase !== "admission" && r.method === method ? late : []), { id: r.id, result: response }]);
    const recordUsage = vi.fn();
    try {
      await expect(seat.invoke({ ...h.input, recordUsage, reserve: () => {
        if (phase === "admission") h.sessions[0].queue.push(...late);
        return 1000;
      } })).resolves.toEqual(success);
      expect(recordUsage).toHaveBeenCalledWith("unknown");
      expect(h.sessions[0].close).not.toHaveBeenCalled();
    } finally { await seat.close!(); }
  });

it.each([
  ["active", "tool_event", (threadId: unknown) => notification("item/completed", { threadId, item: { type: "dynamicToolCall" } })],
  ["active", "runtime_not_tool_free", (threadId: unknown) => notification("item/completed", { threadId, item: { type: "unknownItem" } })],
  ["active", "runtime_not_tool_free", (threadId: unknown) => notification("item/completed", { threadId, item: { type: ["agentMessage"] } })],
  ["active", "runtime_not_tool_free", (threadId: unknown) => notification("unknown/notification", { threadId })],
  ["admission", "runtime_not_tool_free", (threadId: unknown) => moderationMetadata({ threadId, extra: true })],
  ["admission", "runtime_not_tool_free", (threadId: unknown) => notification("item/completed", { threadId, item: { type: "dynamicToolCall" } })],
  ["cleanup", "tool_event", (threadId: unknown) => ({ id: 999, method: "item/tool/call", params: { threadId } })],
  ["cleanup", "runtime_not_tool_free", (threadId: unknown) => notification("unknown/notification", { threadId })],
] as const)("keeps previous-thread unsafe traffic fail closed during %s: %s", async (phase, code, event) => {
  const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies); await seat.start!(60_000); await seat.invoke(h.input);
  const previous = h.requests.find((r) => r.method === "turn/start")!.params.threadId;
  h.onWire((r, response) => [...(r.method === (phase === "cleanup" ? "thread/unsubscribe" : "turn/start") && phase !== "admission" ? [event(previous)] : []), { id: r.id, result: response }]);
  try {
    await expect(seat.invoke({ ...h.input, reserve: () => { if (phase === "admission") h.sessions[0].queue.push(event(previous)); return 1000; } }))
      .rejects.toMatchObject({ detail: { stage: "runtime", code } });
    await expect(seat.invoke(h.input)).rejects.toMatchObject(failure());
  } finally { await seat.close!(); }
});

it("H1 regression: the next queued admission discards a safe previous-thread notification after the drain", async () => {
  const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies); await seat.start!(60_000);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  h.onReply((request) => request.method === "turn/start" ? held : undefined);
  const first = seat.invoke(h.input);
  const second = seat.invoke({ ...h.input, reserve: () => {
    // The first invoke has completed trailingUsage before the mutex admits this reservation.
    const previousThreadId = h.requests.find((request) => request.method === "turn/start")!.params.threadId;
    h.sessions[0].queue.push(notification("item/reasoning/textDelta", { threadId: previousThreadId, turnId: "turn-1", delta: "late" }));
    return 1000;
  } }).catch((error: unknown) => error);
  release();
  try {
    await expect(first).resolves.toEqual(success);
    await expect(second).resolves.toEqual(success);
    expect(h.requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
  } finally { await seat.close!(); }
});

// Reuse the review's EventEmitter/PassThrough child fake through the production FIFO.
function productionTurnHarness() {
  const h = harness(); const children: ChildProcessWithoutNullStreams[] = [];
  const turns: { issue: string; child: ChildProcessWithoutNullStreams; complete: () => void }[] = [];
  const killed: ChildProcessWithoutNullStreams[] = []; let maxSessions = 0;
  const sessionFactory = vi.fn<NonNullable<StewardshipAstraSeatDependencies["sessionFactory"]>>((invocation) => {
    let threadNumber = 0;
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    Object.assign(child, { pid: 1234 + children.length, exitCode: null, signalCode: null,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    children.push(child); maxSessions = Math.max(maxSessions, children.filter((entry) => entry.exitCode === null).length);
    child.stdin.on("data", (data) => {
      const request = JSON.parse(String(data)) as { id?: number | string; method?: string; params?: { threadId?: string; input?: { text: string }[] } };
      if (request.id === undefined || !request.method) return;
      let result = h.responses[request.method];
      if (request.method === "thread/start") result = { ...h.thread, thread: { ...h.thread.thread, id: `thread-${++threadNumber}` } };
      if (request.method === "turn/start") {
        const threadId = request.params!.threadId!;
        const issue = request.params!.input![0].text; const turnId = `turn-${turns.length + 1}`;
        result = { turn: { id: turnId, status: "inProgress" } };
        turns.push({ issue, child, complete: () => {
          const inputTokens = issue === "issue A" ? 100 : 200;
          const events = [
            notification("thread/tokenUsage/updated", { threadId, turnId,
              tokenUsage: { last: { inputTokens, cachedInputTokens: 20, outputTokens: 8 } } }),
            notification("item/completed", { threadId, turnId,
              item: { id: `answer-${turnId}`, type: "agentMessage", text: JSON.stringify({ issue }), phase: "final_answer" } }),
            notification("turn/completed", { threadId, turn: { id: turnId, status: "completed" } }),
          ];
          child.stdout.emit("data", Buffer.from(events.map((event) => JSON.stringify(event)).join("\n") + "\n"));
        } });
      }
      queueMicrotask(() => child.stdout.emit("data", Buffer.from(JSON.stringify({ id: request.id, result }) + "\n")));
    });
    return openStewardshipSeatSession(invocation, { spawnProcess: () => child, killTree: async () => {
      killed.push(child); Object.assign(child, { exitCode: 0 }); child.emit("exit", 0);
    } });
  });
  const seat = createStewardshipAstraSeat({ ...h.dependencies, now: () => performance.now(), sessionFactory });
  return { ...h, seat, children, turns, killed, sessionFactory, get maxSessions() { return maxSessions; } };
}

it("serializes overlapping production Astra turns and binds each issue's usage", async () => {
  const h = productionTurnHarness(); await h.seat.start!(60_000);
  const usageA = vi.fn(), usageB = vi.fn(); const completed: string[] = [];
  const a = h.seat.invoke({ ...h.input, prompt: "issue A", recordUsage: usageA }).then((answer) => { completed.push("A"); return answer; });
  await vi.waitFor(() => expect(h.turns).toHaveLength(1));
  const b = h.seat.invoke({ ...h.input, prompt: "issue B", recordUsage: usageB }).then((answer) => { completed.push("B"); return answer; });
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(h.turns.map((turn) => turn.issue)).toEqual(["issue A"]); expect(h.reserve).toHaveBeenCalledOnce();
    h.turns[0].complete(); await expect(a).resolves.toMatchObject({ assessment: { issue: "issue A" } });
    await vi.waitFor(() => expect(h.turns).toHaveLength(2)); h.turns[1].complete();
    await expect(b).resolves.toMatchObject({ assessment: { issue: "issue B" } });
    expect(completed).toEqual(["A", "B"]); expect(h.sessionFactory).toHaveBeenCalledOnce(); expect(h.maxSessions).toBe(1);
    expect(usageA).toHaveBeenLastCalledWith({ inputTokens: 100, cachedInputTokens: 20, uncachedInputTokens: 80, outputTokens: 8 });
    expect(usageB).toHaveBeenLastCalledWith({ inputTokens: 200, cachedInputTokens: 20, uncachedInputTokens: 180, outputTokens: 8 });
    expect(h.killed).toEqual([]);
  } finally { for (const turn of h.turns) turn.complete(); await Promise.allSettled([a, b]); await h.seat.close!(); }
});

it("finishes timeout cleanup before requalifying an already queued production peer", async () => {
  const h = productionTurnHarness(); await h.seat.start!(60_000);
  const reserveB = vi.fn(() => 1000); const usageB = vi.fn();
  const a = h.seat.invoke({ ...h.input, prompt: "issue A", reserve: () => 100 }).catch((error: unknown) => error);
  await vi.waitFor(() => expect(h.turns).toHaveLength(1));
  const b = h.seat.invoke({ ...h.input, prompt: "issue B", reserve: reserveB, recordUsage: usageB });
  try {
    expect(reserveB).not.toHaveBeenCalled();
    await expect(a).resolves.toMatchObject({ detail: { code: "assessment_timeout" } });
    await vi.waitFor(() => expect(h.turns).toHaveLength(2));
    expect(h.killed).toEqual([h.children[0]]); expect(h.maxSessions).toBe(1);
    h.turns[1].complete(); await expect(b).resolves.toMatchObject({ assessment: { issue: "issue B" } });
    expect(reserveB).toHaveBeenCalledOnce(); expect(h.sessionFactory).toHaveBeenCalledTimes(2);
    expect(usageB).toHaveBeenLastCalledWith({ inputTokens: 200, cachedInputTokens: 20, uncachedInputTokens: 180, outputTokens: 8 });
    expect(h.killed).toEqual([h.children[0]]);
  } finally { for (const turn of h.turns) turn.complete(); await Promise.allSettled([a, b]); await h.seat.close!(); }
});

it("counts queue time against a queued peer's startup budget instead of requalifying past it", async () => {
  // Executed review of f1d918a9f: a queued requalification reused the startup budget captured
  // before it waited, so it could run up to a full startup timeout past the run deadline.
  const h = productionTurnHarness(); await h.seat.start!(60_000);
  const reserveB = vi.fn(() => 1000);
  const a = h.seat.invoke({ ...h.input, prompt: "issue A", reserve: () => 100 }).catch((error: unknown) => error);
  await vi.waitFor(() => expect(h.turns).toHaveLength(1));
  const b = h.seat.invoke({ ...h.input, prompt: "issue B", startupTimeoutMs: 5, reserve: reserveB }).catch((error: unknown) => error);
  try {
    await expect(a).resolves.toMatchObject({ detail: { code: "assessment_timeout" } });
    await expect(b).resolves.toMatchObject({ detail: { code: "assessment_deadline" } });
    expect(reserveB).not.toHaveBeenCalled();
    expect(h.sessionFactory).toHaveBeenCalledTimes(1);
  } finally { for (const turn of h.turns) turn.complete(); await Promise.allSettled([a, b]); await h.seat.close!(); }
});

function rankingAssessment() {
  const { proposed: _proposed, ...legacy } = assessmentFixture(); void _proposed;
  return { ...legacy, binding: { ...legacy.binding, rubric: "roadmap-backlog-ranking/v1" }, codeNeeded: [],
    ranking: Object.fromEntries(Object.entries({ lane: "product", tier: "v1_not_blocking", milestoneStep: 6,
      value: 8, effort: "low", severity: "none", doneStale: "no" }).map(([field, value]) => [field, { status: "assessed", value, rationale: "Current evidence." }])) };
}

// Mirrors the sort host at issueConcurrency 2: every issue starts its seats before invoking them, and
// the next issue is admitted only once the previous issue's two initial reservations are complete.
function issueConcurrencyTwoHarness() {
  const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies); const assessment = rankingAssessment();
  h.setEvents([finalAnswer(JSON.stringify(assessment)), turnComplete()]);
  const glmInvoke = vi.fn(async ({ reserve }: Parameters<StewardshipSeat["invoke"]>[0]) => {
    reserve(); return { assessment, observedModel: "fixture" };
  });
  const assess = (reservationsComplete: () => void) => {
    let initial = 0;
    return assessStewardshipIssue({ evidence: evidenceFixture(), policy, now: () => now,
      deadlineAt: "2026-09-23T12:30:00.000Z", seats: [seat, { family: "glm", requestedModel: "fixture", invoke: glmInvoke }],
      reserveCall: (attempt) => { if (attempt === 1 && ++initial === 2) reservationsComplete(); },
      archive: () => {}, reserveExpansion: () => {}, expand: async () => { throw new Error("Unexpected expansion"); } });
  };
  const run = async (issues: number) => {
    const results: Awaited<ReturnType<typeof assess>>[] = [];
    let admitted = 0; const inFlight = new Set<Promise<void>>();
    while (admitted < issues) {
      const index = admitted++;
      let admitNext!: () => void; const reserved = new Promise<void>((resolve) => { admitNext = resolve; });
      const task: Promise<void> = assess(admitNext).then((result) => { results[index] = result; })
        .finally(() => { admitNext(); inFlight.delete(task); });
      inFlight.add(task);
      await reserved;
      if (inFlight.size >= 2) await Promise.race(inFlight);
    }
    await Promise.all(inFlight);
    return results;
  };
  return { h, seat, glmInvoke, assess, run };
}

it("serves a queued second issue's seat start after the first issue's 65-second turn (run 868d5bce)", async () => {
  const { h, seat, assess } = issueConcurrencyTwoHarness();
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  let turns = 0;
  h.onReply((request) => { if (request.method === "turn/start" && ++turns === 1) return held.then(() => h.advance(65_000)); });
  let admitSecond!: () => void; const firstReserved = new Promise<void>((resolve) => { admitSecond = resolve; });
  const first = assess(admitSecond);
  try {
    await firstReserved;
    // #2556 was admitted here: its seat start queues behind #2555's whole Codex turn.
    const second = assess(() => {});
    release();
    const results = await Promise.all([first, second]);
    for (const result of results) expect(result, JSON.stringify(result.diagnostics)).toMatchObject({ status: "assessed" });
    expect(h.requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
    expect(h.sessionFactory).toHaveBeenCalledOnce(); expect(h.sessions[0].close).not.toHaveBeenCalled();
    await expect(assess(() => {})).resolves.toMatchObject({ status: "assessed" });
  } finally { release(); await seat.close!(); }
});

it("assesses a 40-issue slice at issueConcurrency 2 with one qualified session and no seat_unavailable", async () => {
  const { h, seat, glmInvoke, run } = issueConcurrencyTwoHarness();
  h.onReply((request) => { if (request.method === "turn/start") h.advance(65_000); });
  try {
    const results = await run(40);
    expect(results).toHaveLength(40);
    for (const result of results) expect(result, JSON.stringify(result.diagnostics)).toMatchObject({ status: "assessed", reason: null });
    expect(h.requests.filter((request) => request.method === "turn/start")).toHaveLength(40);
    expect(glmInvoke).toHaveBeenCalledTimes(40);
    // One session, qualified once; every assessment thread is still requalified and unsubscribed.
    expect(h.sessionFactory).toHaveBeenCalledOnce(); expect(h.readExecutableHash).toHaveBeenCalledOnce();
    expect(h.requests.filter((request) => request.method === "thread/start")).toHaveLength(41);
    expect(h.requests.filter((request) => request.method === "mcpServerStatus/list")).toHaveLength(41);
    expect(h.requests.filter((request) => request.method === "thread/unsubscribe")).toHaveLength(41);
  } finally { await seat.close!(); }
});

it("restarts a cleanly closed session for the queued second issue after the first issue's turn times out", async () => {
  const { h, seat, assess } = issueConcurrencyTwoHarness();
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  let turns = 0;
  h.onReply((request) => {
    if (request.method !== "turn/start" || ++turns !== 1) return;
    // Issue A's first read lands after its 240-second turn budget, so the turn times out and closes the session.
    h.onNext(() => { h.advance(240_001); h.onNext(() => {}); });
    return held;
  });
  let admitSecond!: () => void; const firstReserved = new Promise<void>((resolve) => { admitSecond = resolve; });
  const first = assess(admitSecond);
  try {
    await firstReserved;
    const second = assess(() => {});
    release();
    const [, secondResult] = await Promise.all([first, second]);
    expect(secondResult, JSON.stringify(secondResult.diagnostics)).toMatchObject({ status: "assessed" });
    expect(h.sessions[0].close).toHaveBeenCalledOnce(); expect(h.sessionFactory).toHaveBeenCalledTimes(2);
    await expect(assess(() => {})).resolves.toMatchObject({ status: "assessed" });
  } finally { release(); await seat.close!(); }
});

it("bounds a queued restart by the run time left at lock acquisition, not by time queued", async () => {
  const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies); await seat.start!(60_000);
  // Issue A's first read lands 100 s in, past its turn budget, so the turn times out and closes the session.
  h.onReply((request) => { if (request.method === "turn/start") h.onNext(() => { h.advance(100_001); h.onNext(() => {}); }); });
  const a = seat.invoke({ ...h.input, reserve: () => 100_000 }).catch((error: unknown) => error);
  // Queued behind A, this start's 60 s call-time budget is spent; the run still has time at acquisition.
  const restart = seat.start!(60_000, () => 600_000).then(() => "started", (error: unknown) => error);
  try {
    await expect(a).resolves.toMatchObject({ detail: { code: "assessment_timeout" } });
    await expect(restart).resolves.toBe("started");
    expect(h.sessions[0].close).toHaveBeenCalledOnce(); expect(h.sessionFactory).toHaveBeenCalledTimes(2);
    h.onReply(() => {});
    await expect(seat.invoke({ ...h.input, runRemainingMs: () => 600_000 })).resolves.toEqual(success);
    await seat.close!();
    // A closed seat never restarts, whatever run time is left.
    await expect(seat.start!(60_000, () => 600_000)).rejects.toMatchObject(failure());
  } finally { await seat.close!(); }
});

it("refuses a queued restart once the run deadline has passed", async () => {
  const h = productionTurnHarness(); await h.seat.start!(60_000);
  const a = h.seat.invoke({ ...h.input, prompt: "issue A", reserve: () => 100 }).catch((error: unknown) => error);
  await vi.waitFor(() => expect(h.turns).toHaveLength(1));
  const restart = h.seat.start!(60_000, () => 0).then(() => "started", (error: unknown) => error);
  try {
    await expect(a).resolves.toMatchObject({ detail: { code: "assessment_timeout" } });
    await expect(restart).resolves.toMatchObject({ detail: { stage: "startup", code: "assessment_deadline" } });
    expect(h.sessionFactory).toHaveBeenCalledOnce();
  } finally { for (const turn of h.turns) turn.complete(); await a; await h.seat.close!(); }
});

// Decision table for the shared seat's deadline contract (#2572). Running out of run time is a
// deadline that leaves the seat available; a qualification fault, or a qualification that outlives
// the 60-second cap while the run still has time, fails closed and makes the seat unavailable.
describe("shared Astra seat deadline contract", () => {
  type Row = {
    readonly closedByPeerTimeout?: boolean; readonly via: "start" | "invoke"; readonly runLeftMs: number;
    readonly qualificationMs?: number; readonly mismatch?: boolean; readonly close?: "unconfirmed" | "throws";
    readonly outcome: "ok" | { readonly stage: string; readonly code: string; readonly check?: string };
    readonly sessions: number; readonly availableAfter: boolean;
  };
  const deadline = { stage: "startup", code: "assessment_deadline" } as const;
  it.each<[string, Row]>([
    ["start on a qualified session with run time left", { via: "start", runLeftMs: 600_000, outcome: "ok", sessions: 1, availableAfter: true }],
    ["start on a qualified session with the run spent", { via: "start", runLeftMs: 0, outcome: "ok", sessions: 1, availableAfter: true }],
    ["start after a peer timeout with run time left", { closedByPeerTimeout: true, via: "start", runLeftMs: 600_000, outcome: "ok", sessions: 2, availableAfter: true }],
    ["start after a peer timeout with the run spent", { closedByPeerTimeout: true, via: "start", runLeftMs: 0, outcome: deadline, sessions: 1, availableAfter: true }],
    ["invoke with run time left", { via: "invoke", runLeftMs: 600_000, outcome: "ok", sessions: 1, availableAfter: true }],
    ["invoke with the run spent at lock acquisition", { via: "invoke", runLeftMs: 0, outcome: deadline, sessions: 1, availableAfter: true }],
    ["qualification that outlives the run", { via: "invoke", runLeftMs: 1_000, qualificationMs: 2_000, outcome: deadline, sessions: 1, availableAfter: true }],
    ...(["unconfirmed", "throws"] as const).map((close): [string, Row] => [`qualification that outlives the run when its close ${close === "throws" ? "throws" : "is unconfirmed"}`,
      { via: "invoke", runLeftMs: 1_000, qualificationMs: 2_000, close,
        outcome: { stage: "transport", code: "assessment_cleanup_failed" }, sessions: 1, availableAfter: false }]),
    ["qualification that outlives the 60-second cap", { via: "invoke", runLeftMs: 600_000, qualificationMs: 60_001,
      outcome: { stage: "startup", code: "seat_startup_timeout", check: "startup_timeout" }, sessions: 1, availableAfter: false }],
    ["qualification mismatch", { via: "invoke", runLeftMs: 600_000, mismatch: true,
      outcome: { stage: "startup", code: "seat_unavailable", check: "thread_model" }, sessions: 1, availableAfter: false }],
  ])("%s", async (_name, row) => {
    const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies); await seat.start!(60_000);
    try {
      if (row.closedByPeerTimeout) {
        h.onReply((request) => { if (request.method === "turn/start") h.onNext(() => { h.advance(1_001); h.onNext(() => {}); }); });
        await expect(seat.invoke(h.input)).rejects.toMatchObject({ detail: { code: "assessment_timeout" } });
        h.onReply(() => {});
      }
      const startedAt = h.dependencies.now!();
      const runRemainingMs = () => row.runLeftMs - (h.dependencies.now!() - startedAt);
      if (row.mismatch) h.thread.model = "wrong-model";
      if (row.close === "unconfirmed") h.sessions[0].close.mockResolvedValue(false);
      if (row.close === "throws") h.sessions[0].close.mockRejectedValue(new Error(PRIVATE));
      if (row.qualificationMs) h.onReply((request) => { if (request.method === "thread/start") h.advance(row.qualificationMs!); });
      h.reserve.mockClear();
      const call = row.via === "start" ? seat.start!(60_000, runRemainingMs).then(() => undefined)
        : seat.invoke({ ...h.input, runRemainingMs }).then(() => undefined);
      if (row.outcome === "ok") await expect(call).resolves.toBeUndefined();
      else {
        await expect(call).rejects.toMatchObject({ detail: row.outcome });
        expect(h.reserve).not.toHaveBeenCalled();
      }
      expect(h.sessionFactory).toHaveBeenCalledTimes(row.sessions);
      h.onReply(() => {}); h.thread.model = "gpt-6-astra";
      const later = { ...h.input, runRemainingMs: () => 600_000 };
      if (row.availableAfter) {
        await seat.start!(60_000, later.runRemainingMs);
        await expect(seat.invoke(later)).resolves.toEqual(success);
      } else {
        await expect(seat.start!(60_000, later.runRemainingMs)).rejects.toMatchObject(failure());
        await expect(seat.invoke(later)).rejects.toMatchObject(failure());
      }
      // An unconfirmed process cleanup is the seat's close outcome; the row already asserted the rest.
    } finally { await seat.close!().catch(() => {}); }
  });
});

it("still charges queue time to a queued restart whose caller supplies no run-time callback", async () => {
  const h = productionTurnHarness(); await h.seat.start!(60_000);
  const a = h.seat.invoke({ ...h.input, prompt: "issue A", reserve: () => 100 }).catch((error: unknown) => error);
  await vi.waitFor(() => expect(h.turns).toHaveLength(1));
  // Issue A's turn times out and closes the session, so this start is a real restart.
  const restart = h.seat.start!(5).then(() => "started", (error: unknown) => error);
  try {
    await expect(a).resolves.toMatchObject({ detail: { code: "assessment_timeout" } });
    await expect(restart).resolves.toMatchObject({ detail: { stage: "startup", code: "assessment_deadline" } });
    expect(h.sessionFactory).toHaveBeenCalledOnce();
  } finally { for (const turn of h.turns) turn.complete(); await a; await h.seat.close!(); }
});

it.each(["thread_model", "thread_sandbox", "inventory"] as const)(
  "names the failed %s qualification check in the seat_unavailable diagnostic", async (check) => {
    const { h, seat, assess } = issueConcurrencyTwoHarness();
    try {
      await expect(assess(() => {})).resolves.toMatchObject({ status: "assessed" });
      if (check === "thread_model") h.thread.model = "wrong-model";
      if (check === "thread_sandbox") h.thread.sandbox.networkAccess = true;
      if (check === "inventory") h.inventory.data = [{ name: PRIVATE }];
      const result = await assess(() => {});
      expect(result).toMatchObject({ status: "deferred", reason: "seat_unavailable",
        diagnostics: [{ seat: "codex", stage: "startup", code: "seat_unavailable", field: "$", check }] });
      expect(JSON.stringify(result.diagnostics)).not.toContain(PRIVATE);
      await expect(assess(() => {})).resolves.toMatchObject({ status: "deferred", reason: "seat_unavailable" });
    } finally { await seat.close!(); }
  });

it("qualifies once and retains one run session across multiple seat calls", async () => {
  const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies);
  await seat.start!(60_000); await seat.start!(60_000);
  const recordUsage = vi.fn();
  for (const inputTokens of [100, 200]) {
    h.setEvents([notification("thread/tokenUsage/updated", { threadId: "thread-1", turnId: "turn-1",
      tokenUsage: { last: { inputTokens, cachedInputTokens: 40, outputTokens: 8 }, total: { inputTokens: 9999, cachedInputTokens: 999, outputTokens: 999 } } }),
    finalAnswer(), turnComplete()]);
    await expect(seat.invoke({ ...h.input, recordUsage })).resolves.toEqual(success);
  }
  expect(recordUsage.mock.calls.map(([usage]) => usage)).toEqual([
    { inputTokens: 100, cachedInputTokens: 40, uncachedInputTokens: 60, outputTokens: 8 },
    { inputTokens: 200, cachedInputTokens: 40, uncachedInputTokens: 160, outputTokens: 8 },
  ]);
  expect(h.readExecutableHash).toHaveBeenCalledOnce(); expect(h.sessionFactory).toHaveBeenCalledOnce();
  expect(h.sessions[0].close).not.toHaveBeenCalled();
  await seat.close!(); expect(h.sessions[0].close).toHaveBeenCalledOnce();
});

it.each([
  notification("error", { error: { codexErrorInfo: "usageLimitExceeded" } }),
  notification("error", { error: { message: "insufficient_quota" } }),
  notification("account/rateLimits/updated", { rateLimits: { primary: { usedPercent: 100 }, credits: { hasCredits: false, unlimited: false } } }),
  { id: "astra-turn", error: { message: "HTTP 402" } },
  notification("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status: "failed", error: { message: "quota exhausted" } } }),
])("classifies Astra quota notification without leaking provider text: %j", async (event) => {
  const h = harness(); h.setEvents([event]); const recordUsage = vi.fn();
  await expect(createStewardshipAstraSeat(h.dependencies).invoke({ ...h.input, recordUsage }))
    .rejects.toMatchObject({ message: "stopped_usage_limit" });
  expect(recordUsage).toHaveBeenCalledWith("unknown");
  expect(h.sessions[0].close).toHaveBeenCalledOnce();
});

it("keeps a bare Astra 429 transient", async () => {
  const h = harness(); h.setEvents([notification("error", { error: { message: "HTTP 429 Too many requests" } })]);
  await expect(createStewardshipAstraSeat(h.dependencies).invoke(h.input)).rejects.toMatchObject({ detail: { code: "refused" } });
});

it("retains trailing usage before allowing the next turn on the run session", async () => {
  const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies); const recordUsage = vi.fn();
  await seat.start!(60_000);
  const telemetry = notification("thread/tokenUsage/updated", { threadId: "thread-1", turnId: "turn-1",
    tokenUsage: { last: { inputTokens: 80, cachedInputTokens: 30, outputTokens: 7 } } });
  h.setEvents([finalAnswer(), turnComplete(), telemetry]);
  await expect(seat.invoke({ ...h.input, recordUsage })).resolves.toEqual(success);
  expect(recordUsage).toHaveBeenCalledWith({ inputTokens: 80, cachedInputTokens: 30, uncachedInputTokens: 50, outputTokens: 7 });
  h.setEvents([finalAnswer(), turnComplete()]);
  await expect(seat.invoke({ ...h.input, recordUsage })).resolves.toEqual(success);
  expect(recordUsage.mock.calls[1]).toEqual(["unknown"]);
  await seat.close!();
});

it("continues after a settled Astra 429 without requalifying the run session", async () => {
  const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies); await seat.start!(60_000);
  h.setEvents([notification("error", { error: { message: "HTTP 429 Too many requests" } }), turnComplete("failed")]);
  await expect(seat.invoke(h.input)).rejects.toMatchObject({ detail: { code: "refused" } });
  h.setEvents([finalAnswer(), turnComplete()]); await expect(seat.invoke(h.input)).resolves.toEqual(success);
  expect(h.sessionFactory).toHaveBeenCalledOnce(); await seat.close!();
});

it("assessment_timeout on attempt 1, then the retry succeeds on the same run", async () => {
  vi.useFakeTimers(); const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies);
  await seat.start!(60_000);
  h.onReply((request) => request.method === "turn/start" ? new Promise<void>(() => {}) : undefined);
  const first = seat.invoke(h.input).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await first).toMatchObject({ detail: { code: "assessment_timeout" } });
  h.onReply(() => {});
  await seat.start!(60_000);
  await expect(seat.invoke(h.input)).resolves.toEqual(success);
  expect(h.reserve).toHaveBeenCalledTimes(2); expect(h.sessionFactory).toHaveBeenCalledTimes(2);
  expect(h.sessions[0].close).toHaveBeenCalledOnce(); expect(h.directories[0].remove).toHaveBeenCalledOnce();
  await seat.close!(); expect(h.sessions[1].close).toHaveBeenCalledOnce();
});

it.each(["success", "startup_failure"])("defers the assessment engine's timeout retry until the next startup barrier with %s", async (outcome) => {
  const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies);
  const { proposed: _proposed, ...legacy } = assessmentFixture(); void _proposed;
  const assessment = { ...legacy, binding: { ...legacy.binding, rubric: "roadmap-backlog-ranking/v1" }, codeNeeded: [],
    ranking: Object.fromEntries(Object.entries({ lane: "product", tier: "v1_not_blocking", milestoneStep: 6,
      value: 8, effort: "low", severity: "none", doneStale: "no" }).map(([field, value]) => [field, { status: "assessed", value, rationale: "Current evidence." }])) };
  h.setEvents([finalAnswer(JSON.stringify(assessment)), turnComplete()]);
  let turns = 0;
  h.onReply((request) => {
    if (request.method === "turn/start" && ++turns === 1) {
      h.onNext(() => { h.advance(240_001); h.onNext(() => {}); });
      if (outcome === "startup_failure") h.readExecutableHash.mockResolvedValue("bad-hash");
    }
  });
  const glmInvoke = vi.fn(async ({ reserve }: Parameters<StewardshipSeat["invoke"]>[0]) => {
    reserve(); return { assessment, observedModel: "fixture" };
  });
  const assess = () => assessStewardshipIssue({ evidence: evidenceFixture(), policy, now: () => now,
    deadlineAt: "2026-09-23T12:30:00.000Z", seats: [seat, { family: "glm", requestedModel: "fixture", invoke: glmInvoke }],
    reserveCall: () => {}, archive: () => {}, reserveExpansion: () => {}, expand: async () => { throw new Error("Unexpected expansion"); } });
  const result = await assess();
  expect(result, JSON.stringify(result.diagnostics)).toMatchObject({ status: "deferred", reason: "seat_requalify_required",
    assessments: [{ envelope: { seat: { family: "glm" } } }] });
  expect(h.readExecutableHash).toHaveBeenCalledOnce(); expect(glmInvoke).toHaveBeenCalledOnce();
  expect(await assess()).toMatchObject(outcome === "success" ? { status: "assessed" } : { status: "deferred", reason: "seat_unavailable" });
  expect(h.readExecutableHash).toHaveBeenCalledTimes(2); expect(glmInvoke).toHaveBeenCalledTimes(outcome === "success" ? 2 : 1);
  await seat.close!();
});

it.each([false, true])("closes a timed-out turn and requires explicit requalification (clock request=%s)", async (clockRequest) => {
  const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies);
  await seat.start!(60_000);
  let reads = 0;
  h.onReply((request) => { if (request.method === "turn/start") h.onNext(() => { if (++reads === 2) { h.advance(1001); h.onNext(() => {}); } }); });
  h.setEvents([finalAnswer(), ...(clockRequest ? [{ id: "cleanup-clock", method: "currentTime/read", params: {} }] : []),
    turnComplete("interrupted"), notification("thread/tokenUsage/updated")]);
  await expect(seat.invoke(h.input)).rejects.toMatchObject({ detail: { code: "assessment_timeout" } });
  expect(h.sessions[0].close).toHaveBeenCalledOnce(); expect(h.directories[0].remove).toHaveBeenCalledOnce();
  expect(h.requests.some((request) => request.method === "turn/interrupt" || request.id === "cleanup-clock")).toBe(false);
  await expect(seat.invoke(h.input)).rejects.toBeInstanceOf(StewardshipSeatRequalifyRequired);
  expect(h.reserve).toHaveBeenCalledOnce();
  await seat.start!(60_000);
  h.setEvents([finalAnswer(), turnComplete()]); await expect(seat.invoke(h.input)).resolves.toEqual(success);
  expect(h.sessionFactory).toHaveBeenCalledTimes(2);
  await seat.close!();
});

it.each([
  ["tool_event", { id: 99, method: "item/commandExecution/requestApproval", params: {} }],
  ["tool_event", itemEvent("dynamicToolCall")],
  ["runtime_not_tool_free", notification("model/rerouted")],
  ["stopped_usage_limit", notification("account/rateLimits/updated", { rateLimits: { primary: { usedPercent: 100 } } })],
] as [string, unknown][])("screens %s read exactly at expiry and closes the session", async (code, event) => {
  const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies); await seat.start!(60_000);
  let reads = 0;
  h.onReply((request) => { if (request.method === "turn/start") h.onNext(() => { if (++reads === 2) h.advance(1000); }); });
  h.setEvents([event, turnComplete("interrupted")]);
  await expect(seat.invoke(h.input)).rejects.toMatchObject(code === "stopped_usage_limit"
    ? { message: "stopped_usage_limit" } : { detail: { stage: "runtime", code } });
  expect(h.sessions[0].close).toHaveBeenCalledOnce(); expect(h.directories[0].remove).toHaveBeenCalledOnce();
  expect(h.requests.some((request) => request.method === "turn/interrupt")).toBe(false);
  if (code !== "stopped_usage_limit") await expect(seat.start!(60_000)).rejects.toMatchObject(failure());
  await seat.close!();
});

it("requalifies after a timeout while draining traffic before a shared turn", async () => {
  const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies); await seat.start!(60_000);
  h.reserve.mockImplementationOnce(() => {
    h.sessions[0].partial.push(notification("warning"));
    h.onNext(() => { throw new StewardshipAssessmentError({ stage: "transport", code: "assessment_timeout", field: "$" }); });
    return 1000;
  });
  await expect(seat.invoke(h.input)).rejects.toMatchObject({ detail: { code: "assessment_timeout" } });
  h.onNext(() => {});
  await expect(seat.invoke(h.input)).rejects.toBeInstanceOf(StewardshipSeatRequalifyRequired);
  await seat.start!(60_000);
  await expect(seat.invoke(h.input)).resolves.toEqual(success);
  expect(h.sessionFactory).toHaveBeenCalledTimes(2); expect(h.sessions[0].close).toHaveBeenCalledOnce();
  await seat.close!();
});

it.each([
  ["tool_event", { id: 99, method: "item/tool/call", params: {} }],
  ["runtime_not_tool_free", notification("model/rerouted")],
] as [string, unknown][])("disables a shared session after settled trailing %s", async (code, event) => {
  const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies); await seat.start!(60_000);
  h.setEvents([finalAnswer(), turnComplete(), event]);
  await expect(seat.invoke(h.input)).rejects.toMatchObject({ detail: { code } });
  await expect(seat.start!(60_000)).rejects.toMatchObject(failure());
  expect(h.sessionFactory).toHaveBeenCalledOnce(); expect(h.sessions[0].close).toHaveBeenCalledOnce();
  await seat.close!();
});

it("disables a shared session when timeout cleanup is unconfirmed", async () => {
  vi.useFakeTimers(); const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies);
  await seat.start!(60_000); h.sessions[0].close.mockResolvedValue(false);
  h.onReply((request) => request.method === "turn/start" ? new Promise<void>(() => {}) : undefined);
  const first = seat.invoke(h.input).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await first).toMatchObject({ detail: { code: "assessment_cleanup_failed" } });
  await expect(seat.start!(60_000)).rejects.toMatchObject(failure());
  expect(h.sessionFactory).toHaveBeenCalledOnce(); expect(h.sessions[0].close).toHaveBeenCalledOnce();
  await expect(seat.close!()).rejects.toMatchObject({ detail: { code: "assessment_cleanup_failed" } });
});

it.each([
  ["invalid_json", [finalAnswer("not JSON"), turnComplete()]],
  ["refused", [finalAnswer(), turnComplete("failed")]],
  ["refused", [finalAnswer(), turnComplete("inProgress")]],
  ["assessment_output_limit", [finalAnswer("a".repeat(ASSESSMENT_OUTPUT_BYTES + 1)), turnComplete()]],
  ["refused", [finalAnswer(JSON.stringify({ reason: PRIVATE })), turnComplete()]],
] as [string, unknown[]][])("%s on issue 1, issue 2 still assessed by Astra", async (code, events) => {
  const h = harness(); const seat = createStewardshipAstraSeat({ ...h.dependencies, sensitiveValues: [PRIVATE] });
  const input = { ...h.input, prompt: "Assess the selected issue." };
  await seat.start!(60_000); h.setEvents(events);
  await expect(seat.invoke(input)).rejects.toMatchObject({ detail: { code } });
  h.setEvents([finalAnswer(), turnComplete()]);
  await seat.start!(60_000); await expect(seat.invoke(input)).resolves.toEqual(success);
  expect(h.sessionFactory).toHaveBeenCalledOnce(); expect(h.sessions[0].close).not.toHaveBeenCalled();
  await seat.close!();
});

it.each([undefined, null, {}, "malformed", { usedPercent: "100" }, { usedPercent: NaN }, { usedPercent: Infinity }])(
  "accepts a partial rate-limit payload with primary 42 and secondary %j", async (secondary) => {
    const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies);
    await seat.start!(60_000);
    h.setEvents([notification("account/rateLimits/updated", { rateLimits: { primary: { usedPercent: 42 },
      ...(secondary === undefined ? {} : { secondary }) } }), finalAnswer(), turnComplete()]);
    await expect(seat.invoke(h.input)).resolves.toEqual(success);
    h.setEvents([finalAnswer(), turnComplete()]); await expect(seat.invoke(h.input)).resolves.toEqual(success);
    expect(h.sessionFactory).toHaveBeenCalledOnce(); await seat.close!();
  },
);

describe("Astra turn confinement", () => {
  it("accepts exact-shape moderation metadata between streamed deltas and the final answer", async () => {
    const h = harness();
    const text = JSON.stringify(ANSWER);
    h.setEvents([
      ...[text.slice(0, 20), text.slice(20)].map((delta) => notification("item/agentMessage/delta", {
        threadId: "thread-1", turnId: "turn-1", itemId: "answer-1", delta,
      })),
      moderationMetadata({ metadata: { sentinel: MODERATION_SENTINEL, padding: "x".repeat(ASSESSMENT_OUTPUT_BYTES + 1) } }),
      finalAnswer(), turnComplete(),
    ]);
    const answer = await createStewardshipAstraSeat(h.dependencies).invoke(h.input);
    expect(answer).toEqual(success);
    expect(JSON.stringify(answer)).not.toContain(MODERATION_SENTINEL);
    expect(h.sessions[0].close).toHaveBeenCalledOnce();
  });

  it.each([
    ["extra params key", moderationMetadata({ extra: true }), "runtime_not_tool_free"],
    ...["metadata", "threadId", "turnId"].map((missing) => [
      `missing ${missing}`, notification("turn/moderationMetadata", Object.fromEntries(
        Object.entries(moderationMetadata().params).filter(([key]) => key !== missing))), "runtime_not_tool_free",
    ]),
    ["wrong thread", moderationMetadata({ threadId: "another-thread" }), "refused"],
    ["wrong turn", moderationMetadata({ turnId: "another-turn" }), "refused"],
    ["empty turn", moderationMetadata({ turnId: "" }), "refused"],
    ["non-string turn", moderationMetadata({ turnId: 1 }), "refused"],
    ["id", { ...moderationMetadata(), id: 99 }, "tool_event"],
    ["error", { ...moderationMetadata(), error: {} }, "runtime_not_tool_free"],
    ["result", { ...moderationMetadata(), result: {} }, "runtime_not_tool_free"],
  ] as [string, unknown, string][])("refuses moderation metadata with %s", async (_name, event, code) => {
    const h = harness(); h.setEvents([event, finalAnswer(), turnComplete()]);
    const caught = await createStewardshipAstraSeat(h.dependencies).invoke(h.input).catch((error: unknown) => error);
    expect(caught).toMatchObject({ detail: { stage: "runtime", code } });
    expect(JSON.stringify(caught)).not.toContain(MODERATION_SENTINEL);
    expect(h.sessions[0].close).toHaveBeenCalledOnce();
  });

  it.each(["queued", "partial"])("accepts %s moderation metadata after turn completion", async (arrival) => {
    const h = harness(); h.setEvents([finalAnswer(), turnComplete(), ...(arrival === "queued" ? [moderationMetadata()] : [])]);
    if (arrival === "partial") h.onReply((request) => {
      if (request.method === "turn/start") h.sessions[0].partial.push(moderationMetadata());
    });
    const answer = await createStewardshipAstraSeat(h.dependencies).invoke(h.input);
    expect(answer).toEqual(success);
    expect(JSON.stringify(answer)).not.toContain(MODERATION_SENTINEL);
    expect(h.sessions[0].close).toHaveBeenCalledOnce();
  });

  it.each([
    ["extra key", moderationMetadata({ extra: true }), "runtime_not_tool_free"],
    ["missing metadata", notification("turn/moderationMetadata", { threadId: "thread-1", turnId: "turn-1" }), "runtime_not_tool_free"],
    ["wrong thread", moderationMetadata({ threadId: "another-thread" }), "refused"],
    ["wrong turn", moderationMetadata({ turnId: "another-turn" }), "refused"],
    ["id", { ...moderationMetadata(), id: 99 }, "tool_event"],
    ["error", { ...moderationMetadata(), error: {} }, "runtime_not_tool_free"],
    ["result", { ...moderationMetadata(), result: {} }, "runtime_not_tool_free"],
  ] as [string, unknown, string][])("refuses trailing moderation metadata with %s", async (_name, event, code) => {
    const h = harness(); h.setEvents([finalAnswer(), turnComplete(), event]);
    const caught = await createStewardshipAstraSeat(h.dependencies).invoke(h.input).catch((error: unknown) => error);
    expect(caught).toMatchObject({ detail: { stage: "runtime", code,
      ...(["tool_event", "runtime_not_tool_free"].includes(code) ? { method: "turn/moderationMetadata" } : {}) } });
    expect(JSON.stringify(caught)).not.toContain(MODERATION_SENTINEL);
  });

  it.each([
    [notification("probe/unknownNotification"), "runtime_not_tool_free", "probe/unknownNotification"],
    [{ id: 99, method: "probe/toolRequest", params: {} }, "tool_event", "probe/toolRequest"],
    [itemEvent("commandExecution", "item/started"), "tool_event", "item/started:commandExecution"],
    [itemEvent("unknownType"), "runtime_not_tool_free", "item/completed:unknownType"],
    [itemEvent('hostile "type"'), "runtime_not_tool_free", "item/completed:(unrecognized)"],
    ...['probe/with space', 'probe/with"quote', "a".repeat(65), "probe/newline\n"].map((method) => [
      notification(method), "runtime_not_tool_free", "(unrecognized)",
    ]),
  ] as [unknown, string, string][])("records only a validated method for rejected turn message %j", async (event, code, method) => {
    const h = harness(); h.setEvents([event]);
    const caught = await createStewardshipAstraSeat(h.dependencies).invoke(h.input).catch((error: unknown) => error);
    expect(caught).toMatchObject({ detail: { stage: "runtime", code, field: "$", method } });
    expect(stewardshipDiagnostic(caught, "codex", "runtime")).toEqual({ seat: "codex", stage: "runtime", code, field: "$", method });
  });

  it.each(["admission", "trailing", "cleanup"])("preserves the rejected method through %s traffic classification", async (phase) => {
    const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies); await seat.start!(60_000);
    const event = notification("probe/unknownNotification", { private: PRIVATE });
    if (phase === "admission") h.reserve.mockImplementation(() => { h.sessions[0].queue.push(event); return 1000; });
    if (phase === "trailing") h.setEvents([finalAnswer(), turnComplete(), event]);
    if (phase === "cleanup") h.onWire((request, response) => [
      ...(request.method === "thread/unsubscribe" ? [event] : []), { id: request.id, result: response },
    ]);
    try {
      await expect(seat.invoke(h.input)).rejects.toMatchObject({ detail: { code: "runtime_not_tool_free", method: "probe/unknownNotification" } });
    } finally { await seat.close!(); }
  });

  it("records (none) for a rejected settled message without a string method", async () => {
    const h = harness(); h.reserve.mockImplementation(() => { h.sessions[0].queue.push({ method: 7, params: { private: PRIVATE } }); return 1000; });
    await expect(createStewardshipAstraSeat(h.dependencies).invoke(h.input))
      .rejects.toMatchObject({ detail: { code: "runtime_not_tool_free", method: "(none)" } });
  });

  it.each(["admission", "trailing"])("omits method on the %s 1000-read cap", async (phase) => {
    const h = harness();
    const pending = () => h.sessions[0].partial.push(...Array.from({ length: 1001 }, () => notification("warning")));
    if (phase === "admission") h.reserve.mockImplementation(() => { pending(); return 1000; });
    else h.onReply((request) => { if (request.method === "turn/start") pending(); });
    const caught = await createStewardshipAstraSeat(h.dependencies).invoke(h.input).catch((error: unknown) => error);
    expect(caught).toMatchObject({ detail: { stage: "runtime", code: "runtime_not_tool_free" } });
    expect(caught).toBeInstanceOf(StewardshipAssessmentError);
    expect((caught as StewardshipAssessmentError).detail).not.toHaveProperty("method");
    expect(h.sessions[0].partial).toHaveLength(1);
  });

  it("refuses moderation metadata during per-assessment thread qualification", async () => {
    const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies); await seat.start!(60_000);
    h.onWire((request, response) => [
      ...(request.method === "mcpServerStatus/list" ? [moderationMetadata({ threadId: request.params.threadId })] : []),
      { id: request.id, result: response },
    ]);
    try {
      await expect(seat.invoke(h.input)).rejects.toMatchObject(failure());
      expect(h.reserve).not.toHaveBeenCalled();
      expect(h.requests.some((request) => request.method === "turn/start")).toBe(false);
    } finally { await seat.close!(); }
  });

  it("accepts moderation metadata for a finished thread during a later turn", async () => {
    const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies); await seat.start!(60_000); await seat.invoke(h.input);
    const previousThread = h.requests.find((request) => request.method === "turn/start")!.params.threadId;
    h.onWire((request, response) => [
      ...(request.method === "turn/start" ? [moderationMetadata({ threadId: previousThread })] : []),
      { id: request.id, result: response },
    ]);
    try {
      await expect(seat.invoke(h.input)).resolves.toEqual(success);
      expect(h.sessionFactory).toHaveBeenCalledOnce();
      expect(h.sessions[0].close).not.toHaveBeenCalled();
    } finally { await seat.close!(); }
  });

  it("exempts a finished thread's moderation metadata during the next turn's trailing drain", async () => {
    const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies); await seat.start!(60_000);
    try {
      await expect(seat.invoke(h.input)).resolves.toEqual(success);
      const previousThread = h.requests.find((request) => request.method === "turn/start")!.params.threadId;
      expect(h.requests.some((request) => request.method === "thread/unsubscribe" && request.params.threadId === previousThread)).toBe(true);
      h.setEvents([finalAnswer(), turnComplete(), moderationMetadata({ threadId: previousThread, turnId: "turn-1" })]);
      await expect(seat.invoke(h.input)).resolves.toEqual(success);
      h.setEvents([finalAnswer(), turnComplete()]);
      await expect(seat.invoke(h.input)).resolves.toEqual(success);
      expect(h.sessionFactory).toHaveBeenCalledOnce();
      expect(h.sessions[0].close).not.toHaveBeenCalled();
    } finally { await seat.close!(); }
  });

  it.each(["cleanup read", "settled drain", "pending settle"])("exempts finished-thread moderation metadata in the %s and reuses the session", async (position) => {
    const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies); await seat.start!(60_000);
    h.onWire((request, response) => {
      const reply = { id: request.id, result: response };
      if (request.method !== "thread/unsubscribe") return [reply];
      const event = moderationMetadata({ threadId: request.params.threadId });
      if (position === "pending settle") { h.sessions[0].partial.push(event); return [reply]; }
      return position === "cleanup read" ? [event, reply] : [reply, event];
    });
    try {
      const first = await seat.invoke(h.input);
      const second = await seat.invoke(h.input);
      expect([first, second]).toEqual([success, success]);
      expect(JSON.stringify([first, second])).not.toContain(MODERATION_SENTINEL);
      expect(h.sessionFactory).toHaveBeenCalledOnce();
      expect(h.requests.filter((request) => request.method === "turn/start")).toHaveLength(2);
      expect(h.sessions[0].close).not.toHaveBeenCalled();
    } finally { await seat.close!(); }
  });

  it.each(["cleanup read", "settled drain"].flatMap((position) => [
    [position, "extra key", "runtime_not_tool_free"],
    [position, "id", "tool_event"],
    [position, "error", "runtime_not_tool_free"],
    [position, "result", "runtime_not_tool_free"],
    [position, "missing metadata", "runtime_not_tool_free"],
    [position, "invalid turn", "runtime_not_tool_free"],
  ]))("rejects finished-thread moderation metadata with %s / %s", async (position, shape, code) => {
    const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies); await seat.start!(60_000);
    h.onWire((request, response) => {
      const reply = { id: request.id, result: response };
      if (request.method !== "thread/unsubscribe") return [reply];
      const valid = moderationMetadata({ threadId: request.params.threadId });
      const event = shape === "extra key" ? moderationMetadata({ ...valid.params, extra: true })
        : shape === "id" ? { ...valid, id: 99 }
          : shape === "error" ? { ...valid, error: {} }
            : shape === "result" ? { ...valid, result: {} }
              : shape === "invalid turn" ? moderationMetadata({ ...valid.params, turnId: 7 })
                : notification("turn/moderationMetadata", { threadId: request.params.threadId, turnId: "turn-1" });
      return position === "cleanup read" ? [event, reply] : [reply, event];
    });
    try {
      await expect(seat.invoke(h.input)).rejects.toMatchObject({ detail: { stage: "runtime", code, method: "turn/moderationMetadata" } });
      await expect(seat.invoke(h.input)).rejects.toMatchObject(failure());
    } finally { await seat.close!(); }
  });

  it("refuses moderation metadata for an unfinished startup qualification thread before any turn", async () => {
    const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies);
    h.onWire((request, response) => [
      ...(request.method === "mcpServerStatus/list" ? [moderationMetadata({ threadId: request.params.threadId })] : []),
      { id: request.id, result: response },
    ]);
    try {
      await expect(seat.start!(60_000)).rejects.toMatchObject(failure());
      expect(h.requests.some((request) => request.method === "turn/start")).toBe(false);
      expect(h.reserve).not.toHaveBeenCalled();
      expect(h.sessions[0].close).toHaveBeenCalledOnce();
    } finally { await seat.close!(); }
  });

  it.each([
    JSON.stringify(ANSWER),
    `\n\u0060\u0060\u0060json\n${JSON.stringify(ANSWER)}\n\u0060\u0060\u0060\n`,
    `\u0060\u0060\u0060\r\n${JSON.stringify(ANSWER)}\r\n\u0060\u0060\u0060`,
  ])("parses a final answer with the shared fenced-JSON tolerance: %s", async (text) => {
    const h = harness(); h.setEvents([finalAnswer(text), turnComplete()]);
    await expect(createStewardshipAstraSeat(h.dependencies).invoke(h.input)).resolves.toEqual(success);
    expect(h.reserve).toHaveBeenCalledTimes(1);
    expect(h.sessions[0].close).toHaveBeenCalledTimes(1);
  });

  const forbiddenRequests = [
    "account/chatgptAuthTokens/refresh", "applyPatchApproval", "attestation/generate", "execCommandApproval",
    "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval",
    "item/tool/call", "item/tool/requestUserInput", "mcpServer/elicitation/request", "unknown/request",
  ];
  it.each(forbiddenRequests)("kills without answering the server request %s", async (method) => {
    const h = harness();
    h.setEvents([{ id: 99, method, params: { private: PRIVATE } }, finalAnswer(), turnComplete()]);
    const error = await createStewardshipAstraSeat(h.dependencies).invoke(h.input).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ detail: { stage: "runtime", code: "tool_event" } });
    expect(String(error) + JSON.stringify(error)).not.toContain(PRIVATE);
    expect(h.requests.some((r) => r.id === 99)).toBe(false);
    expect(h.sessions[0].close).toHaveBeenCalledTimes(1);
  });

  const toolTypes = [
    "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "webSearch",
    "imageView", "imageGeneration", "functionCallOutput", "sleep", "subAgentActivity",
  ];
  const forbiddenTypes = ["hookPrompt", "plan", "enteredReviewMode", "exitedReviewMode", "contextCompaction", "unknownItem"];
  it.each(["item/started", "item/completed"].flatMap((method) => [
    ...toolTypes.map((type) => [method, type, "tool_event"]),
    ...forbiddenTypes.map((type) => [method, type, "runtime_not_tool_free"]),
  ]))("kills on %s with %s", async (method, type, code) => {
    const h = harness(); h.setEvents([itemEvent(type, method, { private: PRIVATE }), finalAnswer(), turnComplete()]);
    const error = await createStewardshipAstraSeat(h.dependencies).invoke(h.input).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ detail: { stage: "runtime", code } });
    expect(String(error) + JSON.stringify(error)).not.toContain(PRIVATE);
    expect(h.sessions[0].close).toHaveBeenCalledTimes(1);
  });

  it.each([
    "model/rerouted", "thread/settings/updated", "thread/environment/connected", "thread/environment/disconnected",
    "unknown/notification", "rawResponse/completed", "rawResponseItem/completed", "account/gatewayOAuth/changed",
    ...forbiddenRequests,
  ])("fails closed on notification %s", async (method) => {
    const h = harness(); h.setEvents([notification(method, { private: PRIVATE }), finalAnswer(), turnComplete()]);
    const error = await createStewardshipAstraSeat(h.dependencies).invoke(h.input).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ detail: { stage: "runtime", code: "runtime_not_tool_free" } });
    expect(String(error) + JSON.stringify(error)).not.toContain(PRIVATE);
    expect(h.sessions[0].close).toHaveBeenCalledTimes(1);
  });

  it.each(["disabled", "starting", "ready", "failed", "cancelled", undefined])("rejects MCP startup status %s", async (status) => {
    const h = harness(); h.setEvents([notification("mcpServer/startupStatus/updated", { name: PRIVATE, status }), finalAnswer(), turnComplete()]);
    await expect(createStewardshipAstraSeat(h.dependencies).invoke(h.input)).rejects.toMatchObject({ detail: { code: "runtime_not_tool_free" } });
    expect(h.sessions[0].close).toHaveBeenCalledTimes(1);
  });

  it("accepts the benign notifications and allowed item lifecycles", async () => {
    const h = harness();
    h.setEvents([
      ...["thread/started", "thread/status/changed", "thread/tokenUsage/updated", "account/rateLimits/updated",
        "warning", "configWarning", "deprecationNotice", "serverRequest/resolved",
        "model/safetyBuffering/updated", "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded",
        "item/reasoning/textDelta"].map((method) => notification(method, { private: PRIVATE })),
      notification("remoteControl/status/changed", { status: "disabled", private: PRIVATE }),
      notification("turn/started", { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } }),
      ...["userMessage", "reasoning"].flatMap((type) => [itemEvent(type, "item/started"), itemEvent(type)]),
      itemEvent("agentMessage", "item/started", { text: "", phase: "final_answer" }),
      notification("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", itemId: "answer-1", delta: JSON.stringify(ANSWER) }),
      finalAnswer(), turnComplete(),
    ]);
    await expect(createStewardshipAstraSeat(h.dependencies).invoke(h.input)).resolves.toEqual(success);
    expect(h.sessions[0].close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["tool_event", { id: 99, method: "item/tool/call", params: {} }],
    ["runtime_not_tool_free", notification("model/rerouted")],
  ])("preserves %s when cleanup fails and makes the seat unavailable", async (code, event) => {
    const h = harness(); h.setEvents([event]);
    h.onReply((r) => { if (r.method === "turn/start") h.sessions[0].close.mockResolvedValue(false); });
    const seat = createStewardshipAstraSeat(h.dependencies);
    await expect(seat.invoke(h.input)).rejects.toMatchObject({ detail: { stage: "runtime", code } });
    await expect(seat.invoke(h.input)).rejects.toMatchObject(failure());
    expect(h.reserve).toHaveBeenCalledTimes(1);
    expect(h.sessionFactory).toHaveBeenCalledTimes(1);
    expect(h.sessions[0].close).toHaveBeenCalledTimes(1);
  });

  it("answers only currentTime/read with the injected UTC clock, including before the turn acknowledgment", async () => {
    const h = harness();
    h.onWire((r, response) => [
      ...(r.method === "turn/start" ? [{ id: "clock-1", method: "currentTime/read", params: {} }] : []),
      { id: r.id, result: response },
    ]);
    h.setEvents([{ id: 101, method: "currentTime/read", params: {} }, finalAnswer(), turnComplete()]);
    await expect(createStewardshipAstraSeat(h.dependencies).invoke(h.input)).resolves.toEqual(success);
    expect(h.requests.filter((r) => r.result)).toEqual([
      { id: "clock-1", result: { currentTimeAt: 1791030896 } },
      { id: 101, result: { currentTimeAt: 1791030896 } },
    ]);
  });

  it.each([true, false, "throws"])("waits for cleanup and classifies a model timeout when exit confirmation is %s", async (confirmed) => {
    vi.useFakeTimers(); const h = harness();
    let finishClose!: (value: boolean) => void;
    h.onReply((r) => {
      if (r.method === "turn/start") {
        h.sessions[0].close.mockImplementation(() => confirmed === "throws"
          ? Promise.reject(new Error(PRIVATE)) : new Promise<boolean>((resolveClose) => { finishClose = resolveClose; }));
        return new Promise<void>(() => {});
      }
    });
    let settled = false;
    const outcome = createStewardshipAstraSeat(h.dependencies).invoke(h.input).catch((error: unknown) => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.reserve).toHaveBeenCalledTimes(1);
    expect(h.sessions[0].close).toHaveBeenCalledTimes(1);
    if (confirmed !== "throws") { expect(settled).toBe(false); finishClose(confirmed as boolean); }
    const error = await outcome;
    expect(error).toMatchObject({ detail: { stage: "transport", code: confirmed === true ? "assessment_timeout" : "assessment_cleanup_failed" } });
    expect(String(error) + JSON.stringify(error)).not.toContain(PRIVATE);
  });

  it("discards output that arrives after a read deadline and retries with a new process and thread", async () => {
    vi.useFakeTimers(); const h = harness();
    let release!: () => void;
    h.onReply((r) => {
      if (r.method === "turn/start") h.onNext(() => new Promise<void>((resolveNext) => { release = resolveNext; }));
    });
    const seat = createStewardshipAstraSeat(h.dependencies);
    const first = seat.invoke(h.input).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await first).toMatchObject({ detail: { code: "assessment_timeout" } });
    release(); await vi.advanceTimersByTimeAsync(0);
    h.onNext(() => {}); h.onReply(() => {});
    h.thread.thread.id = "thread-2";
    h.responses["turn/start"] = { turn: { id: "turn-2", status: "inProgress" } };
    h.setEvents([
      notification("item/completed", { threadId: "thread-2", turnId: "turn-2", item: { id: "answer-2", type: "agentMessage", text: JSON.stringify(ANSWER) } }),
      notification("turn/completed", { threadId: "thread-2", turn: { id: "turn-2", status: "completed" } }),
    ]);
    await expect(seat.invoke(h.input)).resolves.toEqual(success);
    expect(h.reserve).toHaveBeenCalledTimes(2);
    expect(h.sessionFactory).toHaveBeenCalledTimes(2);
    expect(h.readExecutableHash).toHaveBeenCalledTimes(2);
    expect(h.readConfigText).toHaveBeenCalledTimes(2);
    expect(h.sessions[0].requests.map((r) => r.method)).toEqual(h.sessions[1].requests.filter((r) => r.method !== "thread/unsubscribe").map((r) => r.method));
    expect(h.sessions[1].requests.at(-1)?.method).toBe("thread/unsubscribe");
    expect(h.sessions.map((s) => s.requests.find((r) => r.method === "turn/start")?.params.threadId)).toEqual(["thread-1", "thread-2"]);
    for (const session of h.sessions) expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("counts only time after turn/start against the model limit, including continuous inbound traffic", async () => {
    const h = harness();
    h.onReply((r) => {
      if (r.method !== "turn/start") h.advance(10_000);
      else h.onNext(() => { h.advance(400); });
    });
    h.setEvents([notification("warning"), finalAnswer(), turnComplete()]);
    await expect(createStewardshipAstraSeat(h.dependencies).invoke({ ...h.input, timeoutMs: 60_000 })).rejects.toMatchObject({ detail: { code: "assessment_timeout" } });
    expect(h.reserve).toHaveBeenCalledTimes(1);
    expect(h.sessions[0].close).toHaveBeenCalledTimes(1);
  });

  it("uses the smaller reservation timeout after startup consumes run time", async () => {
    vi.useFakeTimers(); const h = harness();
    const deadline = h.dependencies.now!() + h.input.timeoutMs;
    h.readExecutableHash.mockImplementation(async () => { h.advance(600); return PIN; });
    h.reserve.mockImplementation(() => Math.min(h.input.timeoutMs, deadline - h.dependencies.now!()));
    h.onReply((r) => { if (r.method === "turn/start") return new Promise<void>(() => {}); });
    let settled = false;
    const outcome = createStewardshipAstraSeat(h.dependencies).invoke(h.input).catch((error: unknown) => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(399);
    expect(h.reserve).toHaveReturnedWith(400);
    expect(settled).toBe(false); expect(h.sessions[0].close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ detail: { stage: "transport", code: "assessment_timeout" } });
    expect(h.sessions[0].close).toHaveBeenCalledTimes(1);
  });

  it.each(["snapshot", "deltas", "multiple items"])("caps accumulated agent message bytes from %s", async (mode) => {
    const h = harness();
    const delta = (text: string) => notification("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", itemId: "answer-1", delta: text });
    const oversized = "a".repeat(ASSESSMENT_OUTPUT_BYTES + 1);
    h.setEvents(mode === "snapshot" ? [finalAnswer(oversized), turnComplete()]
      : mode === "deltas" ? [delta(oversized.slice(0, 100)), delta(oversized.slice(100)), finalAnswer(), turnComplete()]
        : [finalAnswer("a".repeat(ASSESSMENT_OUTPUT_BYTES), { phase: "commentary", id: "commentary-1" }), finalAnswer(), turnComplete()]);
    await expect(createStewardshipAstraSeat(h.dependencies).invoke(h.input)).rejects.toMatchObject({ detail: { stage: "transport", code: "assessment_output_limit" } });
    expect(h.sessions[0].close).toHaveBeenCalledTimes(1);
  });

  it("does not double charge streamed bytes repeated in the final snapshot", async () => {
    const h = harness(); const text = JSON.stringify({ answer: "a".repeat(ASSESSMENT_OUTPUT_BYTES - 13) });
    expect(Buffer.byteLength(text)).toBe(ASSESSMENT_OUTPUT_BYTES);
    h.setEvents([
      notification("item/agentMessage/delta", { threadId: "thread-1", turnId: "turn-1", itemId: "answer-1", delta: text }),
      finalAnswer(text), turnComplete(),
    ]);
    await expect(createStewardshipAstraSeat(h.dependencies).invoke(h.input)).resolves.toEqual({ assessment: JSON.parse(text), observedModel: success.observedModel });
  });

  it("counts UTF-8 bytes, not characters, toward the answer limit", async () => {
    const h = harness(); h.setEvents([finalAnswer("\u00e9".repeat(ASSESSMENT_OUTPUT_BYTES / 2 + 1)), turnComplete()]);
    await expect(createStewardshipAstraSeat(h.dependencies).invoke(h.input)).rejects.toMatchObject({ detail: { code: "assessment_output_limit" } });
    expect(h.sessions[0].close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["non-JSON", [finalAnswer(PRIVATE), turnComplete()], "response_json", "invalid_json"],
    ["error notification", [notification("error", { message: PRIVATE }), finalAnswer(), turnComplete()], "runtime", "refused"],
    ...["failed", "interrupted", "inProgress", undefined, "unknown"].map((status) => [
      `turn status ${status}`, [finalAnswer(), notification("turn/completed", { threadId: "thread-1", turn: { id: "turn-1", status } })], "runtime", "refused",
    ]),
    ["no final message", [turnComplete()], "runtime", "refused"],
    ["two final messages", [finalAnswer(), finalAnswer(undefined, { id: "answer-2" }), turnComplete()], "runtime", "refused"],
    ["duplicate final completion", [finalAnswer(), finalAnswer(), turnComplete()], "runtime", "refused"],
    ["only commentary", [finalAnswer(undefined, { phase: "commentary" }), turnComplete()], "runtime", "refused"],
    ["unknown phase", [finalAnswer(undefined, { phase: "unknown" }), turnComplete()], "runtime", "refused"],
    ["missing text", [itemEvent("agentMessage"), turnComplete()], "runtime", "refused"],
    ["wrong thread", [notification("item/completed", { threadId: "another-thread", turnId: "turn-1", item: { type: "agentMessage", id: "answer-1", text: "{}" } }), turnComplete()], "runtime", "refused"],
    ["wrong turn", [finalAnswer(), notification("turn/completed", { threadId: "thread-1", turn: { id: "another-turn", status: "completed" } })], "runtime", "refused"],
  ] as [string, unknown[], string, string][])("rejects %s without exposing raw text", async (_name, events, stage, code) => {
    const h = harness(); h.setEvents(events);
    const error = await createStewardshipAstraSeat(h.dependencies).invoke(h.input).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ detail: { stage, code } });
    expect(String(error) + JSON.stringify(error)).not.toContain(PRIVATE);
    expect(h.sessions[0].close).toHaveBeenCalledTimes(1);
  });

  it.each([null, undefined, "final_answer"])("accepts a single final answer with phase %s and ignores commentary", async (phase) => {
    const h = harness(); h.setEvents([
      finalAnswer("Reviewing evidence.", { id: "commentary-1", phase: "commentary" }),
      finalAnswer(undefined, { phase }), turnComplete(),
    ]);
    await expect(createStewardshipAstraSeat(h.dependencies).invoke(h.input)).resolves.toEqual(success);
  });

  it("rejects a configured sensitive value in a parsed answer without exposing it", async () => {
    const h = harness(); h.setEvents([finalAnswer(JSON.stringify({ reason: PRIVATE })), turnComplete()]);
    const error = await createStewardshipAstraSeat({ ...h.dependencies, sensitiveValues: [PRIVATE] })
      .invoke({ ...h.input, prompt: "Assess this evidence." }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ detail: { stage: "response_safety", code: "refused" } });
    expect(String(error) + JSON.stringify(error)).not.toContain(PRIVATE);
    expect(h.sessions[0].close).toHaveBeenCalledTimes(1);
  });

  const archiveAnswer = (seat: StewardshipSeat, deadlineAt = "2026-09-23T12:30:00.000Z") => {
    const archiveRejected = vi.fn();
    const result = assessStewardshipIssue({ evidence: evidenceFixture(), policy, now: () => now, deadlineAt,
      seats: [seat, { family: "glm", requestedModel: "fixture", async invoke({ reserve }) { reserve(); throw new Error("fixture refusal"); } }],
      reserveCall: () => {}, archive: () => {}, archiveRejected,
      reserveExpansion: () => {}, expand: async () => { throw new Error("Unexpected expansion"); } }).finally(() => seat.close?.());
    return { result, archiveRejected };
  };

  it.each(["active turn", "trailing drain"])("excludes moderation metadata from retained artifacts after %s", async (position) => {
    const h = harness();
    h.setEvents(position === "active turn" ? [moderationMetadata(), finalAnswer(), turnComplete()]
      : [finalAnswer(), turnComplete(), moderationMetadata()]);
    const { result, archiveRejected } = archiveAnswer(createStewardshipAstraSeat(h.dependencies));
    const report = await result;
    const text = JSON.stringify(ANSWER);
    expect(archiveRejected).toHaveBeenCalledOnce();
    expect(archiveRejected.mock.calls[0][0]).toEqual({
      sha256: createHash("sha256").update(text).digest("hex"), byteLength: Buffer.byteLength(text), content: text,
    });
    expect(JSON.stringify([report, archiveRejected.mock.calls])).not.toContain(MODERATION_SENTINEL);
  });

  it.each(["schema", "response_json", "response_safety", "failed_turn", "tool_after_answer", "escaped_sensitive"])(
    "retains completed answers through %s rejection with safety screening", async (mode) => {
      const h = harness();
      const unsafe = mode === "response_safety" || mode === "escaped_sensitive";
      const text = mode === "response_json" ? "not JSON" : mode === "escaped_sensitive"
        ? `\u0060\u0060\u0060json\n{\n  "reason": "${PRIVATE.slice(0, -1)}\\u006c"\n}\n\u0060\u0060\u0060`
        : JSON.stringify(unsafe ? { reason: PRIVATE } : ANSWER);
      const ending = mode === "tool_after_answer" || mode === "escaped_sensitive"
        ? { id: 99, method: "item/tool/call", params: {} }
        : turnComplete(mode === "failed_turn" ? "failed" : "completed");
      h.setEvents([finalAnswer(text), ending]);
      const { result, archiveRejected } = archiveAnswer(createStewardshipAstraSeat({ ...h.dependencies, sensitiveValues: [PRIVATE] }));
      const report = await result;
      expect(archiveRejected).toHaveBeenCalledTimes(1);
      expect(archiveRejected.mock.calls[0][0]).toEqual({
        sha256: createHash("sha256").update(text).digest("hex"), byteLength: Buffer.byteLength(text),
        ...(unsafe ? {} : { content: text }),
      });
      expect(archiveRejected.mock.calls[0][1]).toMatchObject({ seat: "codex", stage:
        ["schema", "response_json", "response_safety"].includes(mode) ? mode : "runtime" });
      expect(JSON.stringify(report)).not.toContain(PRIVATE);
      expect(h.sessions[0].close).toHaveBeenCalledTimes(1);
    },
  );

  it("discards even a completed item when the turn times out before turn/completed", async () => {
    vi.useFakeTimers(); const h = harness();
    h.setEvents([finalAnswer()]);
    h.onReply((r) => {
      if (r.method === "turn/start") {
        let reads = 0;
        h.onNext(() => { if (++reads === 3) return new Promise<void>(() => {}); });
      }
    });
    const { result, archiveRejected } = archiveAnswer(createStewardshipAstraSeat(h.dependencies), "2026-09-23T12:00:00.010Z");
    await vi.advanceTimersByTimeAsync(11);
    expect(await result).toMatchObject({ status: "deferred", diagnostics: [{ code: "assessment_timeout" }, { seat: "glm", code: "refused" }] });
    expect(archiveRejected).not.toHaveBeenCalled();
    expect(h.sessions[0].close).toHaveBeenCalledTimes(1);
  });
});
function harness() {
  let clock = 0;
  let configText = 'model = "gpt-6-astra"';
  const config = {
    agents: { enabled: false }, web_search: "disabled", features: Object.fromEntries(FEATURES.map((name) => [name, false])),
    model_provider: "openai", forced_login_method: "chatgpt",
    mcp_servers: {} as Record<string, { enabled: boolean }>,
    private: PRIVATE,
  };
  const thread = {
    thread: { id: "thread-1", environments: [] as unknown }, model: "gpt-6-astra", modelProvider: "openai",
    approvalPolicy: "never", sandbox: { type: "readOnly", networkAccess: false },
    instructionSources: [] as unknown[], runtimeWorkspaceRoots: [] as unknown[],
  };
  const inventory = {
    data: [] as unknown[],
    nextCursor: null as string | null,
  };
  const responses: Record<string, unknown> = {
    initialize: { userAgent: "workflow_tools_roadmap_stewardship/0.160.0 (Windows 10.0.26200; x86_64)" },
    "account/read": { account: { type: "chatgpt", email: PRIVATE } },
    "config/read": { config }, "thread/start": thread, "mcpServerStatus/list": inventory, "thread/unsubscribe": { status: "unsubscribed" },
    "turn/start": { turn: { id: "turn-1", status: "inProgress" } },
  };
  type Request = { id?: number | string; method: string; params: Record<string, unknown>; result?: unknown };
  const requests: Request[] = [];
  const sessions: { close: ReturnType<typeof vi.fn>; requests: Request[]; queue: unknown[]; partial: unknown[] }[] = [];
  const directories: { cwd: string; remove: ReturnType<typeof vi.fn> }[] = [];
  let beforeReply: (request: Request) => void | Promise<void> = () => {};
  let beforeNext: () => void | Promise<void> = () => {};
  let events: unknown[] = [finalAnswer(), turnComplete()];
  let wire: (request: Request, response: unknown) => unknown[] = (request, response) => [{ id: request.id, result: response }];
  const sessionFactory = vi.fn<NonNullable<StewardshipAstraSeatDependencies["sessionFactory"]>>(() => {
    let threadNumber = 0; let threadId = "thread-1";
    const queue: unknown[] = [];
    const local = { close: vi.fn(async () => true), requests: [] as Request[], queue, partial: [] as unknown[] };
    sessions.push(local);
    const session: StewardshipSeatSession = {
      async write(message) {
        const request = message as Request;
        local.requests.push(request); requests.push(request);
        if (request.id === undefined || !request.method) return;
        await beforeReply(request);
        let response = responses[request.method];
        if (request.method === "thread/start" && (response as typeof thread)?.thread?.id === "thread-1") {
          threadId = `thread-${++threadNumber}`;
          response = { ...(response as typeof thread), thread: { ...(response as typeof thread).thread, id: threadId } };
        }
        queue.push(...wire(request, response));
        if (request.method === "turn/start") queue.push(...events.map((event) => {
          const message = event as { params?: { threadId?: string } };
          return message.params?.threadId === "thread-1" ? { ...message, params: { ...message.params, threadId } } : event;
        }));
      },
      async next() {
        await beforeNext();
        // A message whose line was still arriving completes on the next read.
        if (!queue.length && local.partial.length) queue.push(local.partial.shift());
        if (!queue.length) throw new Error(PRIVATE);
        return queue.shift();
      },
      drain: () => queue.splice(0),
      pending: () => local.partial.length > 0,
      close: local.close,
    };
    return session;
  });
  const readExecutableHash = vi.fn<NonNullable<StewardshipAstraSeatDependencies["readExecutableHash"]>>(async () => PIN);
  const readConfigText = vi.fn<NonNullable<StewardshipAstraSeatDependencies["readConfigText"]>>(async () => configText);
  const tempDirFactory = vi.fn(() => {
    const directory = { cwd: `C:/mock-temp/astra-${directories.length}`, remove: vi.fn() };
    directories.push(directory); return directory;
  });
  const dependencies: StewardshipAstraSeatDependencies = {
    executablePath: "C:/mock/codex.exe", readExecutableHash, readConfigText, sessionFactory,
    now: () => clock, utcNow: () => Date.UTC(2026, 9, 3, 12, 34, 56, 789), tempDirFactory,
    codexHome: "C:/mock-dedicated-home", ensureCodexHome: vi.fn(async () => {}),
  };
  const reserve = vi.fn(() => 1000);
  const input = { prompt: PRIVATE, timeoutMs: 1000, startupTimeoutMs: 60_000, reserve };
  return {
    config, thread, inventory, responses, requests, sessions, directories, dependencies, sessionFactory,
    readExecutableHash, readConfigText, tempDirFactory, reserve, input,
    setConfigText(value: string) { configText = value; },
    advance(ms: number) { clock += ms; },
    onReply(callback: typeof beforeReply) { beforeReply = callback; },
    onWire(callback: typeof wire) { wire = callback; },
    onNext(callback: typeof beforeNext) { beforeNext = callback; },
    setEvents(value: unknown[]) { events = value; },
  };
}

describe("Astra startup and reservation", () => {
  it("screens an unsafe prompt before startup or reservation", async () => {
    const h = harness();
    const seat = createStewardshipAstraSeat({ ...h.dependencies, sensitiveValues: [PRIVATE] });
    await expect(seat.invoke(h.input)).rejects.toMatchObject({ detail: { stage: "input", code: "refused" } });
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.readExecutableHash).not.toHaveBeenCalled();
    expect(h.readConfigText).not.toHaveBeenCalled();
    expect(h.sessionFactory).not.toHaveBeenCalled();
    expect(h.tempDirFactory).not.toHaveBeenCalled();
    await expect(seat.invoke({ ...h.input, prompt: "Assess this evidence." })).resolves.toEqual(success);
  });

  const forbiddenStartupTraffic = [
    ...["thread/settings/updated", "model/rerouted", "thread/environment/connected", "unknown/notification",
      "turn/started", "item/agentMessage/delta"].map((method) => notification(method)),
    notification("mcpServer/startupStatus/updated", { name: "alpha", status: "disabled" }),
    moderationMetadata(),
    notification("account/updated", { authMode: "apikey", planType: null }),
    notification("account/updated", {}),
    notification("remoteControl/status/changed", { status: "connected" }),
    notification("remoteControl/status/changed", {}),
    { id: 99, method: "item/tool/call", params: {} },
    { id: 100, method: "currentTime/read", params: {} },
  ];
  it.each(forbiddenStartupTraffic.flatMap((event) => [
    ["before inventory reply", event], ["behind final inventory reply", event],
  ] as const))("rejects startup traffic %s: %j before reserving", async (position, event) => {
    const h = harness();
    h.onWire((r, response) => {
      const reply = { id: r.id, result: response };
      if (r.method !== "mcpServerStatus/list") return [reply];
      return position === "before inventory reply" ? [event, reply] : [reply, event];
    });
    const seat = createStewardshipAstraSeat(h.dependencies);
    await expect(seat.invoke(h.input)).rejects.toMatchObject(failure());
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.requests.some((r) => r.method === "turn/start")).toBe(false);
    expect(h.sessions[0].close).toHaveBeenCalledTimes(1);
    await expect(seat.invoke(h.input)).rejects.toMatchObject(failure());
    expect(h.sessionFactory).toHaveBeenCalledTimes(1);
    await expect(checkStewardshipAstraStartup(h.dependencies)).resolves.toEqual({ ok: false, failedCheck: "protocol" });
  });

  it.each([
    ["tool_event", [{ id: 99, method: "item/tool/call", params: {} }]],
    ["runtime_not_tool_free", [notification("thread/settings/updated")]],
    ["tool_event", [notification("model/rerouted"), { id: 99, method: "currentTime/read", params: {} }]],
  ])("rejects traffic queued during reservation as %s without sending a turn", async (code, events) => {
    const h = harness();
    h.reserve.mockImplementation(() => { h.sessions[0].queue.push(...events as unknown[]); return h.input.timeoutMs; });
    const seat = createStewardshipAstraSeat(h.dependencies);
    await expect(seat.invoke(h.input)).rejects.toMatchObject({ detail: { stage: "runtime", code } });
    expect(h.reserve).toHaveBeenCalledTimes(1);
    expect(h.requests.some((r) => r.method === "turn/start")).toBe(false);
    expect(h.sessions[0].close).toHaveBeenCalledTimes(1);
    await expect(seat.invoke(h.input)).rejects.toMatchObject(failure());
    expect(h.sessionFactory).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["behind the final inventory reply", "startup"], ["across the reservation", "reservation"],
  ] as const)("waits for a message still arriving %s and rejects it before the turn", async (_label, phase) => {
    const h = harness();
    const forbidden = { id: 99, method: "item/tool/call", params: {} };
    if (phase === "startup") h.onWire((r, response) => {
      if (r.method === "mcpServerStatus/list") h.sessions[0].partial.push(forbidden);
      return [{ id: r.id, result: response }];
    });
    else h.reserve.mockImplementation(() => { h.sessions[0].partial.push(forbidden); return h.input.timeoutMs; });
    const seat = createStewardshipAstraSeat(h.dependencies);
    await expect(seat.invoke(h.input)).rejects.toMatchObject(phase === "startup" ? failure() : { detail: { stage: "runtime", code: "tool_event" } });
    expect(h.reserve).toHaveBeenCalledTimes(phase === "startup" ? 0 : 1);
    expect(h.requests.some((r) => r.method === "turn/start")).toBe(false);
    expect(h.sessions[0].close).toHaveBeenCalledTimes(1);
  });

  // Admission contract (closes the drain/settle review loop as an executable table):
  // a complete forbidden message is judged before any wait on a still-arriving line, and the settle
  // after reservation spends the same absolute deadline the turn then receives.
  it.each([
    ["startup", "complete tool request ahead of a never-finishing line"],
    ["reservation", "complete tool request ahead of a never-finishing line"],
  ] as const)("rejects at %s a %s without waiting for the line", async (phase, _case) => {
    const h = harness();
    const forbidden = { id: 99, method: "item/tool/call", params: {} };
    const stillArriving = notification("warning");
    if (phase === "startup") h.onWire((r, response) => {
      if (r.method !== "mcpServerStatus/list") return [{ id: r.id, result: response }];
      h.sessions[0].partial.push(stillArriving);
      return [{ id: r.id, result: response }, forbidden];
    });
    else h.reserve.mockImplementation(() => {
      h.sessions[0].queue.push(forbidden); h.sessions[0].partial.push(stillArriving); return h.input.timeoutMs;
    });
    const seat = createStewardshipAstraSeat(h.dependencies);
    await expect(seat.invoke(h.input)).rejects.toMatchObject(phase === "startup" ? failure() : { detail: { stage: "runtime", code: "tool_event" } });
    // The still-arriving line was never awaited: the complete violation decided first.
    expect(h.sessions[0].partial).toEqual([stillArriving]);
    expect(h.requests.some((r) => r.method === "turn/start")).toBe(false);
    await expect(seat.invoke(h.input)).rejects.toMatchObject(failure());
  });

  it.each([
    ["leaves turn time", 400, "resolves"],
    ["exhausts the reservation", 1_000, "assessment_deadline"],
  ] as const)("charges a post-reservation settle that %s to the turn deadline", async (_label, settleMs, outcome) => {
    const h = harness();
    h.reserve.mockImplementation(() => {
      h.sessions[0].partial.push(notification("warning"));
      h.onNext(() => { h.onNext(() => {}); h.advance(settleMs); });
      return 1_000;
    });
    const result = createStewardshipAstraSeat(h.dependencies).invoke(h.input);
    if (outcome === "resolves") await expect(result).resolves.toEqual(success);
    else {
      await expect(result).rejects.toMatchObject({ detail: { stage: "transport", code: "assessment_deadline" } });
      expect(h.requests.some((r) => r.method === "turn/start")).toBe(false);
    }
    expect(h.reserve).toHaveBeenCalledTimes(1);
  });

  it("allows the closed startup notification set at both queue drains", async () => {
    const h = harness();
    const events = ["thread/started", "thread/status/changed", "account/rateLimits/updated",
      "warning", "configWarning", "deprecationNotice"].map((method) => notification(method))
      .concat(notification("account/updated", { authMode: "chatgpt", planType: "pro" }))
      .concat(notification("remoteControl/status/changed", { status: "disabled" }));
    h.onWire((r, response) => [...events, { id: r.id, result: response },
      ...(r.method === "mcpServerStatus/list" ? events : [])]);
    h.reserve.mockImplementation(() => { h.sessions[0].queue.push(...events); return h.input.timeoutMs; });
    await expect(createStewardshipAstraSeat(h.dependencies).invoke(h.input)).resolves.toEqual(success);
    expect(h.reserve).toHaveBeenCalledTimes(1);
  });

  it("checks the complete handshake with exact launch overrides before reserving once and starting the turn", async () => {
    const h = harness();
    const seat = createStewardshipAstraSeat(h.dependencies);
    expect(seat.family).toBe("codex"); expect(seat.requestedModel).toBe("gpt-6-astra");
    h.reserve.mockImplementation(() => {
      expect(h.requests.at(-1)?.method).toBe("mcpServerStatus/list");
      expect(h.sessions[0].close).not.toHaveBeenCalled();
      return h.input.timeoutMs;
    });
    await expect(seat.invoke(h.input)).resolves.toEqual(success);
    expect(h.reserve).toHaveBeenCalledTimes(1);
    const launch = h.sessionFactory.mock.calls[0][0];
    expect(launch.command).toBe("C:/mock/codex.exe");
    expect(launch.cwd).toBe(h.directories[0].cwd);
    expect(launch.args).toEqual([
      ...["agents.enabled=false", 'web_search="disabled"', 'forced_login_method="chatgpt"',
        'model_provider="openai"', "analytics.enabled=false", "project_doc_max_bytes=0",
        ...FEATURES.map((name) => `features.${name}=false`)].flatMap((value) => ["-c", value]),
      "app-server", "--stdio",
    ]);
    expect(h.requests).toEqual([
      { id: 1, method: "initialize", params: { clientInfo: { name: "workflow_tools_roadmap_stewardship", version: "1" }, capabilities: { experimentalApi: true } } },
      { method: "initialized", params: {} },
      { id: 2, method: "account/read", params: { refreshToken: false } },
      { id: 3, method: "config/read", params: { includeLayers: false, cwd: launch.cwd } },
      { id: 4, method: "thread/start", params: { model: "gpt-6-astra", modelProvider: "openai", allowProviderModelFallback: false,
        environments: [], ephemeral: true, dynamicTools: [], selectedCapabilityRoots: [], runtimeWorkspaceRoots: [],
        cwd: launch.cwd, approvalPolicy: "never", sandbox: "read-only" } },
      { id: 5, method: "mcpServerStatus/list", params: { threadId: "thread-1", detail: "full" } },
      { id: "astra-turn-1", method: "turn/start", params: { threadId: "thread-1", environments: [], input: [{ type: "text", text: PRIVATE, text_elements: [] }] } },
      { id: "astra-thread-2", method: "thread/unsubscribe", params: { threadId: "thread-1" } },
    ]);
    expect(JSON.stringify(h.requests.filter((request) => request.method !== "turn/start"))).not.toContain(PRIVATE);
    expect(h.sessions[0].close).toHaveBeenCalledTimes(1);
    expect(h.directories[0].remove).toHaveBeenCalledTimes(1);
    expect(h.sessions[0].close.mock.invocationCallOrder[0]).toBeLessThan(h.directories[0].remove.mock.invocationCallOrder[0]);
  });

  const cases: [string, StewardshipAstraStartupCheck, (h: ReturnType<typeof harness>) => void][] = [
    ["apikey account", "account", (h) => { h.responses["account/read"] = { account: { type: "apikey", email: PRIVATE } }; }],
    ["apiKey account", "account", (h) => { h.responses["account/read"] = { account: { type: "apiKey" } }; }],
    ["missing account", "account", (h) => { h.responses["account/read"] = {}; }],
    ["null account", "account", (h) => { h.responses["account/read"] = { account: null }; }],
    ["wrong version", "version", (h) => { h.responses.initialize = { userAgent: `probe/0.155.1 ${PRIVATE}` }; }],
    ["missing version", "version", (h) => { h.responses.initialize = {}; }],
    ["previous pinned version", "version", (h) => { h.responses.initialize = { userAgent: "probe/0.159.1 Windows" }; }],
    ["near-match version", "version", (h) => { h.responses.initialize = { userAgent: "probe/0.160.01 Windows" }; }],
    ["dots read as wildcards", "version", (h) => { h.responses.initialize = { userAgent: "probe/0x160x0 Windows" }; }],
    ["enabled feature", "config_features", (h) => { h.config.features.code_mode_host = true; }],
    ["missing feature", "config_features", (h) => { delete h.config.features.worktrees; }],
    ["enabled agents", "config_agents", (h) => { h.config.agents.enabled = true; }],
    ["missing agents", "config_agents", (h) => { h.responses["config/read"] = { config: { ...h.config, agents: undefined } }; }],
    ["web search", "config_web_search", (h) => { h.config.web_search = "live"; }],
    ["config provider", "config_provider", (h) => { h.config.model_provider = PRIVATE; }],
    ["config login", "config_login", (h) => { h.config.forced_login_method = "api"; }],
    ["enabled MCP server", "config_mcp", (h) => { h.config.mcp_servers.alpha = { enabled: true }; }],
    ["disabled MCP server", "config_mcp", (h) => { h.config.mcp_servers.alpha = { enabled: false }; }],
    ["null MCP config", "config_mcp", (h) => { h.responses["config/read"] = { config: { ...h.config, mcp_servers: null } }; }],
    ["array MCP config", "config_mcp", (h) => { h.responses["config/read"] = { config: { ...h.config, mcp_servers: [] } }; }],
    ["bare MCP table", "config_scan", (h) => { h.setConfigText('[mcp_servers.alpha]\nenabled = false'); }],
    ["commented MCP definition", "config_scan", (h) => { h.setConfigText('# mcp_servers is documented here'); }],
    ["inline MCP table", "config_scan", (h) => { h.setConfigText(`mcp_servers = { alpha = { command = "${PRIVATE}" } }`); }],
    ["quoted MCP name", "config_scan", (h) => { h.setConfigText('[mcp_servers."alpha"]'); }],
    ["unparseable MCP header", "config_scan", (h) => { h.setConfigText("[mcp_servers]"); }],
    ["nested dotted key", "config_scan", (h) => { h.setConfigText('[other]\nmcp_servers.alpha.command = "private"'); }],
    ["long MCP name", "config_scan", (h) => { h.setConfigText(`[mcp_servers.${"a".repeat(65)}]`); }],
    ["null environments", "thread_environments", (h) => { h.thread.thread.environments = null; }],
    ["missing environments", "thread_environments", (h) => { h.thread.thread.environments = undefined; }],
    ["nonempty environments", "thread_environments", (h) => { h.thread.thread.environments = [PRIVATE]; }],
    ["different model", "thread_model", (h) => { h.thread.model = PRIVATE; }],
    ["different provider", "thread_provider", (h) => { h.thread.modelProvider = PRIVATE; }],
    ["approval enabled", "thread_approval", (h) => { h.thread.approvalPolicy = "on-request"; }],
    ["writable sandbox", "thread_sandbox", (h) => { h.thread.sandbox.type = "workspaceWrite"; }],
    ["sandbox network access", "thread_sandbox", (h) => { h.thread.sandbox.networkAccess = true; }],
    ["missing sandbox network attestation", "thread_sandbox", (h) => { h.responses["thread/start"] = { ...h.thread, sandbox: { type: "readOnly" } }; }],
    ["instruction sources", "thread_instructions", (h) => { h.thread.instructionSources = [PRIVATE]; }],
    ["missing instruction sources", "thread_instructions", (h) => { h.responses["thread/start"] = { ...h.thread, instructionSources: undefined }; }],
    ["workspace roots", "thread_roots", (h) => { h.thread.runtimeWorkspaceRoots = [PRIVATE]; }],
    ["missing workspace roots", "thread_roots", (h) => { h.responses["thread/start"] = { ...h.thread, runtimeWorkspaceRoots: undefined }; }],
    ["missing thread ID", "thread_id", (h) => { h.thread.thread.id = ""; }],
    ["disabled MCP inventory server", "inventory", (h) => { h.inventory.data = [{ name: "alpha", runtimeStatus: "disabled", tools: {}, resources: [], resourceTemplates: [] }]; }],
    ["unknown MCP inventory entry", "inventory", (h) => { h.inventory.data = [null]; }],
    ["unending pagination", "inventory_pagination", (h) => { h.inventory.nextCursor = PRIVATE; }],
    ["hash mismatch", "executable_hash", (h) => { h.readExecutableHash.mockResolvedValue("bad-hash"); }],
    ["missing executable", "executable_missing", (h) => { h.readExecutableHash.mockRejectedValue(Object.assign(new Error(PRIVATE), { code: "ENOENT" })); }],
    ["hash read error", "executable_hash", (h) => { h.readExecutableHash.mockRejectedValue(new Error(PRIVATE)); }],
    ["config read error", "config_scan", (h) => { h.readConfigText.mockRejectedValue(new Error(PRIVATE)); }],
    ["JSON-RPC error", "protocol", (h) => { h.onWire((r) => [{ id: r.id, error: { message: PRIVATE } }]); }],
    ["server request", "protocol", (h) => { h.onWire(() => [{ id: 99, method: "item/tool/call", params: { private: PRIVATE } }]); }],
    ["wrong response ID", "protocol", (h) => { h.onWire(() => [{ id: 99, result: PRIVATE }]); }],
    ["process exit", "version", (h) => { h.onReply(() => { throw new Error(PRIVATE); }); }],
  ];

  it.each(cases)("fails closed for %s, sanitizes preflight, and never launches again", async (_name, failedCheck, arrange) => {
    const h = harness(); arrange(h);
    const seat = createStewardshipAstraSeat(h.dependencies);
    const error = await seat.invoke(h.input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(StewardshipAssessmentError);
    expect(error).toMatchObject(failure());
    expect(String(error) + JSON.stringify(error)).not.toContain(PRIVATE);
    expect(h.reserve).not.toHaveBeenCalled();
    for (const s of h.sessions) expect(s.close).toHaveBeenCalledTimes(1);
    for (const d of h.directories) expect(d.remove).toHaveBeenCalledTimes(1);
    const count = h.sessionFactory.mock.calls.length;
    const hashes = h.readExecutableHash.mock.calls.length;
    await expect(seat.invoke(h.input)).rejects.toMatchObject(failure());
    expect(h.sessionFactory).toHaveBeenCalledTimes(count);
    expect(h.readExecutableHash).toHaveBeenCalledTimes(hashes);
    if (["executable_missing", "executable_hash", "config_scan"].includes(failedCheck)) expect(count).toBe(0);
    if (failedCheck === "account") expect(h.requests.map((r) => r.method)).not.toContain("config/read");
    if (failedCheck === "inventory_pagination") expect(h.requests.filter((r) => r.method === "mcpServerStatus/list")).toHaveLength(10);
    await expect(checkStewardshipAstraStartup(h.dependencies)).resolves.toEqual({ ok: false, failedCheck });
  });

  it("starts every call afresh and reruns the hash, config and all RPC checks", async () => {
    const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies);
    await expect(seat.invoke(h.input)).resolves.toEqual(success);
    await expect(seat.invoke(h.input)).resolves.toEqual(success);
    expect(h.reserve).toHaveBeenCalledTimes(2);
    expect(h.sessionFactory).toHaveBeenCalledTimes(2);
    expect(h.readExecutableHash).toHaveBeenCalledTimes(2);
    expect(h.readConfigText).toHaveBeenCalledTimes(2);
    expect(h.directories[0].cwd).not.toBe(h.directories[1].cwd);
    expect(h.sessions[0].requests.map((r) => r.method)).toEqual(h.sessions[1].requests.map((r) => r.method));
    for (const s of h.sessions) expect(s.close).toHaveBeenCalledTimes(1);
  });

  it("becomes unavailable if startup fails on the second call", async () => {
    const h = harness(); const seat = createStewardshipAstraSeat(h.dependencies);
    await expect(seat.invoke(h.input)).resolves.toEqual(success);
    h.config.agents.enabled = true;
    await expect(seat.invoke(h.input)).rejects.toMatchObject(failure());
    await expect(seat.invoke(h.input)).rejects.toMatchObject(failure());
    expect(h.reserve).toHaveBeenCalledTimes(1); expect(h.sessionFactory).toHaveBeenCalledTimes(2);
  });

  it("preserves the exact reservation refusal and closes the prepared process", async () => {
    const h = harness(); const refusal = new Error("host reservation refused");
    h.reserve.mockImplementation(() => { throw refusal; });
    const seat = createStewardshipAstraSeat(h.dependencies);
    await expect(seat.invoke(h.input)).rejects.toBe(refusal);
    expect(h.requests.some((r) => r.method === "turn/start")).toBe(false);
    expect(h.sessions[0].close).toHaveBeenCalledTimes(1); expect(h.directories[0].remove).toHaveBeenCalledTimes(1);
    h.reserve.mockReset().mockReturnValue(h.input.timeoutMs);
    await expect(seat.invoke(h.input)).resolves.toEqual(success);
    expect(h.sessionFactory).toHaveBeenCalledTimes(2);
  });

  it("follows inventory cursors to completion and tolerates startup notifications", async () => {
    const h = harness(); h.inventory.nextCursor = "page-two";
    h.onReply((r) => { if (r.params.cursor === "page-two") h.inventory.nextCursor = null; });
    h.onWire((r, response) => [{ method: "thread/started", params: { private: PRIVATE } }, { id: r.id, result: response }]);
    await expect(checkStewardshipAstraStartup(h.dependencies)).resolves.toEqual({ ok: true });
    expect(h.requests.at(-1)?.params).toEqual({ threadId: "thread-1", detail: "full", cursor: "page-two" });
    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.requests.some((r) => r.method === "turn/start")).toBe(false);
  });

  it("accepts absent effective MCP config without adding per-server overrides", async () => {
    const h = harness();
    const config: Record<string, unknown> = { ...h.config };
    delete config.mcp_servers;
    h.responses["config/read"] = { config };
    await expect(checkStewardshipAstraStartup(h.dependencies)).resolves.toEqual({ ok: true });
    expect(h.sessionFactory.mock.calls[0][0].args.some((arg) => arg.startsWith("mcp_servers."))).toBe(false);
  });

  it("replaces the inherited login home and excludes credential-shaped parent variables", async () => {
    vi.stubEnv("OPENAI_API_KEY", PRIVATE); vi.stubEnv("SOME_TOKEN", PRIVATE); vi.stubEnv("MY_PASSWORD", PRIVATE);
    vi.stubEnv("CODEX_HOME", "C:/mock-login-home");
    const h = harness();
    await expect(checkStewardshipAstraStartup(h.dependencies)).resolves.toEqual({ ok: true });
    const env = h.sessionFactory.mock.calls[0][0].env;
    expect(Object.keys(env).some((key) => /API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key))).toBe(false);
    expect(env.CODEX_HOME).toBe(resolve(h.dependencies.codexHome!));
    expect(h.dependencies.ensureCodexHome).toHaveBeenCalledWith(env.CODEX_HOME);
    expect(h.readConfigText.mock.calls[0][0]).toBe(join(env.CODEX_HOME!, "config.toml"));
    vi.stubEnv("CODEX_HOME", undefined);
    const next = harness(); await checkStewardshipAstraStartup({ ...next.dependencies, codexHome: undefined });
    expect(next.sessionFactory.mock.calls[0][0].env.CODEX_HOME).toBe(STEWARDSHIP_ASTRA_CODEX_HOME);
    expect(STEWARDSHIP_ASTRA_CODEX_HOME).toBe(resolve(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
      "WorkflowTools", "github-issue-roadmap", "astra-seat-codex-home"));
  });

  it("treats a missing dedicated config as zero MCP servers and proceeds", async () => {
    const h = harness();
    h.readConfigText.mockRejectedValue(Object.assign(new Error(PRIVATE), { code: "ENOENT" }));
    h.config.mcp_servers = {}; h.inventory.data = [];
    await expect(createStewardshipAstraSeat(h.dependencies).invoke(h.input)).resolves.toEqual(success);
    expect(h.sessionFactory.mock.calls[0][0].args.some((arg) => arg.startsWith("mcp_servers."))).toBe(false);
  });

  it("fails config_scan when creating the dedicated home fails", async () => {
    const h = harness();
    await expect(checkStewardshipAstraStartup({ ...h.dependencies, ensureCodexHome: async () => { throw new Error(PRIVATE); } }))
      .resolves.toEqual({ ok: false, failedCheck: "config_scan" });
    expect(h.readConfigText).not.toHaveBeenCalled(); expect(h.sessionFactory).not.toHaveBeenCalled();
  });

  it("accepts a slow startup within the total deadline", async () => {
    const h = harness(); h.onReply((r) => { if (["initialize", "account/read", "config/read", "thread/start", "mcpServerStatus/list"].includes(r.method)) h.advance(11_000); });
    await expect(createStewardshipAstraSeat(h.dependencies).invoke({ ...h.input, timeoutMs: 60_000 })).resolves.toEqual(success);
    expect(h.reserve).toHaveBeenCalledTimes(1);
  });

  it("bounds the whole startup, including hashing, and never retries a timeout", async () => {
    const h = harness();
    h.readExecutableHash.mockImplementation(async () => { h.advance(30_000); return PIN; });
    h.onReply(() => { h.advance(10_000); });
    const seat = createStewardshipAstraSeat(h.dependencies);
    await expect(seat.invoke(h.input)).rejects.toMatchObject(failure("seat_startup_timeout"));
    await expect(seat.invoke(h.input)).rejects.toMatchObject(failure());
    expect(h.reserve).not.toHaveBeenCalled(); expect(h.sessionFactory).toHaveBeenCalledTimes(1);
    expect(h.sessions[0].close).toHaveBeenCalledTimes(1); expect(h.directories[0].remove).toHaveBeenCalledTimes(1);
  });

  it("enforces the caller's smaller startup budget", async () => {
    const h = harness(); h.onReply(() => { h.advance(101); });
    await expect(createStewardshipAstraSeat(h.dependencies).invoke({ ...h.input, startupTimeoutMs: 100 })).rejects.toMatchObject(failure("seat_startup_timeout"));
    expect(h.reserve).not.toHaveBeenCalled();
  });

  it("bounds a stalled session write with the wall timer and closes it", async () => {
    vi.useFakeTimers(); const h = harness(); h.onReply(() => new Promise<void>(() => {}));
    const outcome = createStewardshipAstraSeat(h.dependencies).invoke({ ...h.input, startupTimeoutMs: 10 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(await outcome).toMatchObject(failure("seat_startup_timeout"));
    expect(h.reserve).not.toHaveBeenCalled(); expect(h.sessions[0].close).toHaveBeenCalledTimes(1);
  });

  it("cannot launch a late session after a hash read outlives the startup timeout", async () => {
    vi.useFakeTimers(); const h = harness();
    let finish!: (hash: string) => void;
    h.readExecutableHash.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    const outcome = checkStewardshipAstraStartup({ ...h.dependencies, startupTimeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(outcome).resolves.toEqual({ ok: false, failedCheck: "startup_timeout" });
    finish(PIN); await vi.advanceTimersByTimeAsync(1);
    expect(h.sessionFactory).not.toHaveBeenCalled(); expect(h.readConfigText).not.toHaveBeenCalled();
  });

  it("cannot launch a late session after the config read outlives the startup timeout", async () => {
    vi.useFakeTimers(); const h = harness();
    let finish!: (text: string) => void;
    h.readConfigText.mockImplementation(() => new Promise<string>((resolve) => { finish = resolve; }));
    const outcome = checkStewardshipAstraStartup({ ...h.dependencies, startupTimeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(outcome).resolves.toEqual({ ok: false, failedCheck: "startup_timeout" });
    finish(""); await vi.advanceTimersByTimeAsync(1);
    expect(h.sessionFactory).not.toHaveBeenCalled(); expect(h.tempDirFactory).not.toHaveBeenCalled();
  });

  it("sanitizes cleanup failure and still attempts directory removal", async () => {
    const h = harness(); h.onReply(() => { h.sessions[0].close.mockRejectedValue(new Error(PRIVATE)); });
    await expect(checkStewardshipAstraStartup(h.dependencies)).resolves.toEqual({ ok: false, failedCheck: "cleanup" });
    expect(h.directories[0].remove).toHaveBeenCalledTimes(1);
  });

  it("keeps a completed answer when only the empty temp directory cannot be removed", async () => {
    const h = harness();
    h.reserve.mockImplementation(() => { h.directories[0].remove.mockImplementation(() => { throw new Error(PRIVATE); }); return h.input.timeoutMs; });
    const seat = createStewardshipAstraSeat(h.dependencies);
    await expect(seat.invoke(h.input)).resolves.toEqual(success);
    await expect(seat.invoke(h.input)).resolves.toEqual(success);
    expect(h.sessionFactory).toHaveBeenCalledTimes(2);
  });

  it("reports an unconfirmed process cleanup after a completed turn as a transport failure and disables the seat", async () => {
    const h = harness();
    h.reserve.mockImplementation(() => { h.sessions[0].close.mockResolvedValue(false); return h.input.timeoutMs; });
    const seat = createStewardshipAstraSeat(h.dependencies);
    const error = await seat.invoke(h.input).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ detail: { stage: "transport", code: "assessment_cleanup_failed", field: "$" } });
    expect(String(error) + JSON.stringify(error)).not.toContain(PRIVATE);
    await expect(seat.invoke(h.input)).rejects.toMatchObject(failure());
    expect(h.sessionFactory).toHaveBeenCalledTimes(1);
  });

  it("preserves reservation refusal even if cleanup fails, and disables the seat", async () => {
    const h = harness(); const refusal = new Error("reservation refused");
    h.reserve.mockImplementation(() => { h.sessions[0].close.mockResolvedValue(false); throw refusal; });
    const seat = createStewardshipAstraSeat(h.dependencies);
    await expect(seat.invoke(h.input)).rejects.toBe(refusal);
    await expect(seat.invoke(h.input)).rejects.toMatchObject(failure());
    expect(h.sessionFactory).toHaveBeenCalledTimes(1);
  });

  it("preserves a typed host reservation timeout even when cleanup fails", async () => {
    const h = harness(); const refusal = new StewardshipAssessmentError({ stage: "reservation", code: "assessment_timeout", field: "$" });
    h.reserve.mockImplementation(() => { h.sessions[0].close.mockResolvedValue(false); throw refusal; });
    await expect(createStewardshipAstraSeat(h.dependencies).invoke(h.input)).rejects.toBe(refusal);
    expect(h.requests.some((r) => r.method === "turn/start")).toBe(false);
  });
});
