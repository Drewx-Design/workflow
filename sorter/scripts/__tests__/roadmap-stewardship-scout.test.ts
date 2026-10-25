import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nominateStewardshipScoutExcerpts } from "../lib/github-issue-roadmap/stewardship-scout";
import type { StewardshipSeatInvocation } from "../lib/github-issue-roadmap/stewardship-seat-process";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const excerpt = { path: "src/current.ts", startLine: 2, endLine: 4, why: "Relevant implementation, not evidence." };
const stream = (answer: string, usage: unknown = { input_tokens: 100, cached_input_tokens: 90, output_tokens: 5 }) => [
  { type: "thread.started", thread_id: "fixture" },
  { type: "item.completed", item: { type: "agent_message", text: answer } },
  { type: "turn.completed", usage },
].map((event) => JSON.stringify(event)).join("\n");
function setup(stdout = stream(JSON.stringify({ excerpts: [excerpt] }))) {
  const directory = join(tmpdir(), "roadmap-stewardship-scout-fixture");
  const git = vi.fn(); const makeTemp = vi.fn(() => directory); const removeTemp = vi.fn();
  const runCli = vi.fn(async (_input: StewardshipSeatInvocation) => ({ stdout, stderr: "" }));
  const input = { repoRoot: join(tmpdir(), "other-repository"), originMainSha: "a".repeat(40),
    issue: { title: "Bound the result", body: "Inspect relevant code." }, timeoutMs: 120_000 };
  return { directory, git, makeTemp, removeTemp, runCli, input };
}
describe("read-only stewardship scout", () => {
  it("keeps two valid sibling nominations and a fixed rejected slot for lib/x.ts", async () => {
    const h = setup(stream(JSON.stringify({ excerpts: [excerpt, { ...excerpt, path: "lib/x.ts" }, { ...excerpt, startLine: 5, endLine: 6 }] })));
    const result = await nominateStewardshipScoutExcerpts(h.input, h);
    expect(result.scout.outcome).toBe("nominated");
    expect(result.excerpts).toEqual([{ path: excerpt.path, startLine: 2, endLine: 4 },
      { index: 1, status: "rejected" }, { path: excerpt.path, startLine: 5, endLine: 6 }]);
    expect(JSON.stringify(result)).not.toContain("lib/x.ts");
  });
  it.each(["Temporary failure", "quota exhausted"])("rejects an answer when a completed turn is followed by a failed turn: %s", async (message) => {
    const h = setup(`${stream(JSON.stringify({ excerpts: [excerpt] }))}\n${JSON.stringify({ type: "turn.failed", error: { message } })}`);
    const result = await nominateStewardshipScoutExcerpts(h.input, h);
    expect(result.excerpts).toEqual([]); expect(result.scout.outcome).toBe(message === "quota exhausted" ? "usage_limit" : "failed");
  });
  it("pins a detached checkout, uses bounded scrubbed seat transport, records usage and discards prose", async () => {
    vi.stubEnv("GH_TOKEN", "must-not-leak"); vi.stubEnv("DATABASE_URL", "must-not-leak");
    const h = setup(); const result = await nominateStewardshipScoutExcerpts(h.input, h);
    expect(result).toEqual({ excerpts: [{ path: excerpt.path, startLine: 2, endLine: 4 }],
      scout: { outcome: "nominated", usage: { inputTokens: 100, cachedInputTokens: 90, uncachedInputTokens: 10, outputTokens: 5 } } });
    const checkout = h.runCli.mock.calls[0][0].cwd;
    expect(h.git.mock.calls[0][1]).toEqual(["worktree", "prune"]);
    expect(h.git.mock.calls[1][1]).toEqual(["-c", `core.hooksPath=${join(h.directory, "disabled-hooks")}`, "worktree", "add", "--detach", checkout, h.input.originMainSha]);
    const invocation = h.runCli.mock.calls[0][0];
    expect(invocation.args).toEqual(["-a", "never", "exec", "--json", "--model", "gpt-5.6-sol", "-c", "model_reasoning_effort=high", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--color", "never", "--cd", checkout, "-"]);
    expect(invocation.env).not.toHaveProperty("GH_TOKEN"); expect(invocation.env).not.toHaveProperty("DATABASE_URL");
    expect(invocation.timeoutMs).toBeLessThanOrEqual(120_000); expect(invocation.timeoutMs).toBeGreaterThan(0); expect(invocation.input).toContain("strict JSON only");
    expect(h.git.mock.calls[2][1]).toEqual(["worktree", "remove", "--force", checkout]);
    expect(h.git.mock.calls[3][1]).toEqual(["worktree", "prune"]);
    expect(h.removeTemp).toHaveBeenCalledWith(h.directory, expect.objectContaining({ recursive: true, force: true }));
  });
  it.each([
    ["timeout", "assessment_timeout", "timeout"], ["failure", "assessment_exit_failed", "failed"],
    ["quota", "usage_limit_reached", "usage_limit"], ["rate", "rate limit exceeded", "failed"],
    ["output cap", "assessment_output_limit", "failed"],
  ])("removes the checkout on %s", async (_name, message, outcome) => {
    const h = setup(); h.runCli.mockRejectedValue(new Error(message));
    expect(await nominateStewardshipScoutExcerpts(h.input, h)).toEqual({ excerpts: [], scout: { outcome, usage: "unknown" } });
    expect(h.git).toHaveBeenCalledTimes(4); expect(h.removeTemp).toHaveBeenCalledOnce();
  });
  it.each(["not JSON", "```json\n{\"excerpts\":[]}\n```", JSON.stringify({ excerpts: [{ ...excerpt, endLine: 42 }] }),
    JSON.stringify({ excerpts: Array.from({ length: 7 }, () => excerpt) }), JSON.stringify({ excerpts: [], recommendation: "Ship" })])("rejects invalid scout output: %s", async (answer) => {
    const h = setup(stream(answer)); const result = await nominateStewardshipScoutExcerpts(h.input, h);
    expect(result.excerpts).toEqual([]); expect(result.scout.outcome).toBe("invalid_output"); expect(h.removeTemp).toHaveBeenCalledOnce();
  });
  it("records absent usage as unknown and an empty answer as produced_nothing", async () => {
    const h = setup(stream('{"excerpts":[]}', null));
    expect(await nominateStewardshipScoutExcerpts(h.input, h)).toEqual({ excerpts: [], scout: { outcome: "produced_nothing", usage: "unknown" } });
  });
  it("treats a JSON rate-limit error as a transient failure without recording provider prose", async () => {
    const h = setup(JSON.stringify({ type: "turn.failed", error: { message: "Rate limit exceeded: private detail" } }));
    expect(await nominateStewardshipScoutExcerpts(h.input, h)).toEqual({ excerpts: [], scout: { outcome: "failed", usage: "unknown" } });
  });
  it("retains reported tokens and recognizes a nonzero CLI exit whose usage-limit error was only on stdout", async () => {
    const h = setup();
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null, signalCode: null, kill: vi.fn() });
    child.stdin.on("finish", () => {
      child.stdout.write(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 5 } })}\n`);
      child.stdout.write(`${JSON.stringify({ type: "turn.failed", error: { code: "usage_limit_reached" } })}\n`);
      child.emit("close", 1);
    });
    const spawnProcess = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
    expect(await nominateStewardshipScoutExcerpts(h.input, { ...h, runCli: undefined, spawnProcess }))
      .toEqual({ excerpts: [], scout: { outcome: "usage_limit", usage: { inputTokens: 100, cachedInputTokens: 90, uncachedInputTokens: 10, outputTokens: 5 } } });
    expect(spawnProcess).toHaveBeenCalledOnce(); expect(h.removeTemp).toHaveBeenCalledOnce();
  });
  it("cleans the temporary directory even when checkout creation fails", async () => {
    const h = setup(); h.git.mockImplementation((_cwd, args) => { if (args.includes("add")) throw new Error("checkout failed"); });
    expect((await nominateStewardshipScoutExcerpts(h.input, h)).scout.outcome).toBe("failed");
    expect(h.runCli).not.toHaveBeenCalled(); expect(h.git).toHaveBeenCalledTimes(4); expect(h.removeTemp).toHaveBeenCalledOnce();
  });
  it("pins all config isolation flags independently of worktree creation", async () => {
    const h = setup(); await nominateStewardshipScoutExcerpts(h.input, h);
    expect(h.runCli.mock.calls[0][0].args).toEqual(expect.arrayContaining([
      "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--color", "never",
    ]));
  });
  it.each(["src/free form instruction.ts", "other/file.ts", `src/${"a".repeat(297)}`, "src/file?.ts"])("bounds path strings and preserves valid siblings when possible: %s", async (path) => {
    const h = setup(stream(JSON.stringify({ excerpts: [excerpt, { ...excerpt, path }] })));
    const result = await nominateStewardshipScoutExcerpts(h.input, h);
    if (path.length > 300) expect(result.scout.outcome).toBe("invalid_output");
    else expect(result.excerpts).toEqual([{ path: excerpt.path, startLine: 2, endLine: 4 }, { index: 1, status: "rejected" }]);
  });
  it.each(["src/config.ts", "src/../current.ts", "src//current.ts", "docs/credentials.md"])("drops nominations rejected by the evidence path validator: %s", async (path) => {
    const h = setup(stream(JSON.stringify({ excerpts: [excerpt, { ...excerpt, path }] })));
    expect((await nominateStewardshipScoutExcerpts(h.input, h)).excerpts).toEqual([{ path: excerpt.path, startLine: 2, endLine: 4 }, { index: 1, status: "rejected" }]);
  });
  it.each([30_000, 120_000, 240_000, 600_000])("puts the actual transport timeout in the prompt (%s ms)", async (timeoutMs) => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    const h = setup(); await nominateStewardshipScoutExcerpts({ ...h.input, timeoutMs }, h);
    const invocation = h.runCli.mock.calls[0][0];
    expect(invocation.input).toContain(`at most ${Math.max(1, Math.floor(invocation.timeoutMs / 60_000))} minutes`);
  });
  it.each(["rate limit exceeded", "429", "too many requests", "quota exceeded", "quota exhausted", "insufficient_quota", "usage_limit", "depleted credits", "HTTP 402"])("classifies stderr and events by quota exhaustion: %s", async (message) => {
    const outcome = ["rate limit exceeded", "429", "too many requests"].includes(message) ? "failed" : "usage_limit";
    for (const type of ["error", "turn.failed", "stderr"] as const) {
      const h = setup(type === "stderr" ? "CLI banner\n" : JSON.stringify({ type, error: { message } }));
      if (type === "stderr") h.runCli.mockResolvedValue({ stdout: "CLI banner\n", stderr: message });
      expect((await nominateStewardshipScoutExcerpts(h.input, h)).scout.outcome).toBe(outcome);
    }
  });
  it("ignores non-JSON lines and earlier errors and uses the last answer after completed turns", async () => {
    const h = setup(["CLI banner", JSON.stringify({ type: "error", message: "Temporary upstream error" }),
      stream("not the final answer"), "read progress", stream(JSON.stringify({ excerpts: [excerpt] }))].join("\n"));
    expect((await nominateStewardshipScoutExcerpts(h.input, h)).scout.outcome).toBe("nominated");
  });
  it("does not fall back to an earlier valid answer when the last answer is invalid", async () => {
    const h = setup([stream(JSON.stringify({ excerpts: [excerpt] })), stream("invalid final answer")].join("\n"));
    expect((await nominateStewardshipScoutExcerpts(h.input, h)).scout.outcome).toBe("invalid_output");
  });
  it("requires a completed turn even for a valid answer", async () => {
    const h = setup(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"excerpts":[]}' } }));
    expect((await nominateStewardshipScoutExcerpts(h.input, h)).scout.outcome).toBe("invalid_output");
  });
  it("classifies an error without a valid final answer as failed", async () => {
    const h = setup(`${JSON.stringify({ type: "error", message: "Temporary failure" })}\n${stream("invalid")}`);
    expect((await nominateStewardshipScoutExcerpts(h.input, h)).scout.outcome).toBe("failed");
  });
  it.each([null, 42])("rejects a malformed last agent message instead of reusing an earlier answer (%s)", async (text) => {
    const h = setup(`${stream('{"excerpts":[]}')}\n${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } })}`);
    expect((await nominateStewardshipScoutExcerpts(h.input, h)).scout.outcome).toBe("invalid_output");
  });
  it("classifies quota exhaustion on stderr even with a valid stdout answer", async () => {
    const h = setup(); h.runCli.mockResolvedValue({ stdout: stream('{"excerpts":[]}'), stderr: "HTTP 402 Payment Required" });
    expect((await nominateStewardshipScoutExcerpts(h.input, h)).scout.outcome).toBe("usage_limit");
  });
  it("does not remove a temporary directory that failed the safety check", async () => {
    const h = setup(); h.makeTemp.mockReturnValue(h.input.repoRoot);
    expect((await nominateStewardshipScoutExcerpts(h.input, h)).scout.outcome).toBe("failed");
    expect(h.git).not.toHaveBeenCalled(); expect(h.runCli).not.toHaveBeenCalled(); expect(h.removeTemp).not.toHaveBeenCalled();
  });
  it("preserves success when worktree removal fails and prunes after removing the temp directory", async () => {
    const h = setup(); const calls: string[] = [];
    h.git.mockImplementation((_cwd, args) => { calls.push(args.includes("add") ? "add" : args[1]); if (args[1] === "remove") throw new Error("directory already gone"); });
    h.removeTemp.mockImplementation(() => { calls.push("remove-temp"); });
    expect((await nominateStewardshipScoutExcerpts(h.input, h)).scout.outcome).toBe("nominated");
    expect(calls).toEqual(["prune", "add", "remove", "remove-temp", "prune"]);
    expect(h.runCli.mock.calls[0][0].cwd).toMatch(new RegExp(`main-${process.pid}-[a-f0-9-]+$`));
  });
  it("uses a unique checkout name even when the temp-directory seam repeats", async () => {
    const h = setup(); await nominateStewardshipScoutExcerpts(h.input, h); await nominateStewardshipScoutExcerpts(h.input, h);
    expect(h.runCli.mock.calls[0][0].cwd).not.toBe(h.runCli.mock.calls[1][0].cwd);
  });
});
