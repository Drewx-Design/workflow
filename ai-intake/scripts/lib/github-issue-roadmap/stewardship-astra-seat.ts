import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { retainCompletedStewardshipAnswer, STEWARDSHIP_ASTRA_ASSESSMENT_PROTOCOL, STEWARDSHIP_SEAT_STARTUP_MS, StewardshipSeatRequalifyRequired, type StewardshipSeat } from "./stewardship-assessment";
import { StewardshipAssessmentError, stewardshipDiagnostic, stewardshipMessageMethod, type StewardshipDiagnostic } from "./stewardship-diagnostics";
import { assertStewardshipPacketSafe } from "./stewardship-evidence";
import { ASSESSMENT_OUTPUT_BYTES, isStewardshipUsageLimit, StewardshipUsageLimitError, openStewardshipSeatSession, type StewardshipSeatSession } from "./stewardship-seat-process";
import { stewardshipCallUsageSchema, type StewardshipIssueUsage } from "./stewardship-state";
import { seatEnvironment } from "./sweep-seats";
import { STEWARDSHIP_ASTRA_BIN_DIRECTORY, STEWARDSHIP_ASTRA_EXECUTABLE_RELATIVE, STEWARDSHIP_ASTRA_PIN, STEWARDSHIP_ASTRA_ROOT,
  assertStewardshipAstraInstallPath, stewardshipAstraFileSha256, stewardshipAstraTreeManifestSha256, StewardshipAstraInstallPathError,
} from "./stewardship-astra-seat-pin";

export const STEWARDSHIP_ASTRA_CODEX_HOME = join(STEWARDSHIP_ASTRA_ROOT, "astra-seat-codex-home");
const DISABLED_FEATURES = [
  "apps", "plugins", "remote_plugin", "hooks", "shell_tool", "unified_exec", "shell_snapshot",
  "code_mode", "code_mode_host", "browser_use", "browser_use_external", "computer_use",
  "image_generation", "multi_agent", "multi_agent_v2", "view_image", "goals", "sleep_tool",
  "memories", "workspace_dependencies", "skill_search", "skill_mcp_dependency_install",
  "tool_suggest", "in_app_browser", "in_app_local_automation", "browser_use_full_cdp_access",
  "unified_exec_tty", "worktrees", "realtime_conversation",
] as const;

/** Host-owned predicate names only; never attach a response or an underlying error. */
export type StewardshipAstraStartupCheck =
  | "executable_missing" | "executable_hash" | "tree_hash" | "install_path" | "config_scan" | "session" | "version" | "account"
  | "config_agents" | "config_web_search" | "config_features" | "config_provider"
  | "config_login" | "config_mcp" | "thread_environments" | "thread_model"
  | "thread_provider" | "thread_approval" | "thread_sandbox" | "thread_instructions"
  | "thread_roots" | "thread_id" | "inventory" | "inventory_pagination"
  | "protocol" | "startup_timeout" | "cleanup";

export interface StewardshipAstraSeatDependencies {
  readonly codexHome?: string;
  readonly ensureCodexHome?: (path: string) => Promise<void>;
  readonly sensitiveValues?: readonly string[];
  readonly executablePath?: string;
  /** Trusted override of complete install verification: owned path, executable and exact vendor tree. */
  readonly readExecutableHash?: (path: string, signal: AbortSignal) => Promise<string>;
  readonly readConfigText?: (path: string, signal: AbortSignal) => Promise<string>;
  readonly sessionFactory?: (invocation: Parameters<typeof openStewardshipSeatSession>[0]) => StewardshipSeatSession;
  /** Monotonic milliseconds. The wall-clock timer also bounds stalled dependencies. */
  readonly now?: () => number;
  /** UTC Unix milliseconds, independent of the monotonic deadline clock. */
  readonly utcNow?: () => number;
  readonly tempDirFactory?: () => { readonly cwd: string; remove(): void | Promise<void> };
  readonly startupTimeoutMs?: number;
}

class StartupFailure extends Error {
  constructor(readonly failedCheck: StewardshipAstraStartupCheck) { super(failedCheck); }
}

function requireCheck(value: unknown, check: StewardshipAstraStartupCheck): asserts value {
  if (!value) throw new StartupFailure(check);
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function emptyArray(value: unknown): boolean { return Array.isArray(value) && value.length === 0; }
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function executableHash(path: string, signal: AbortSignal): Promise<string> {
  const destination = resolve(dirname(path), "../../..");
  try {
    await assertStewardshipAstraInstallPath(dirname(destination), path, true);
    const hash = await stewardshipAstraFileSha256(path, signal);
    requireCheck(hash === STEWARDSHIP_ASTRA_PIN.executableSha256, "executable_hash");
    try {
      requireCheck(await stewardshipAstraTreeManifestSha256(join(destination, "vendor"), signal)
        === STEWARDSHIP_ASTRA_PIN.treeManifestSha256, "tree_hash");
    } catch (error) {
      if (error instanceof StewardshipAstraInstallPathError) throw error;
      throw new StartupFailure("tree_hash");
    }
    return hash;
  } catch (error) {
    if (error instanceof StewardshipAstraInstallPathError) throw new StartupFailure("install_path");
    throw error;
  }
}

function temporaryDirectory(): { cwd: string; remove(): void } {
  const root = resolve(tmpdir());
  const cwd = mkdtempSync(join(root, "roadmap-stewardship-astra-"));
  return { cwd, remove() {
    if (!resolve(cwd).startsWith(`${root}${sep}roadmap-stewardship-astra-`)) throw new StartupFailure("cleanup");
    rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } };
}

function validateConfig(response: unknown): void {
  const config = object(object(response).config);
  requireCheck(object(config.agents).enabled === false, "config_agents");
  requireCheck(config.web_search === "disabled", "config_web_search");
  requireCheck(DISABLED_FEATURES.every((name) => object(config.features)[name] === false), "config_features");
  requireCheck(config.model_provider === "openai", "config_provider");
  requireCheck(config.forced_login_method === "chatgpt", "config_login");
  requireCheck(!Object.hasOwn(config, "mcp_servers")
    || (isObject(config.mcp_servers) && Object.keys(config.mcp_servers).length === 0), "config_mcp");
}

function validateThread(response: unknown): { threadId: string; observedModel: string } {
  const result = object(response);
  const thread = object(result.thread);
  requireCheck(emptyArray(thread.environments), "thread_environments");
  requireCheck(result.model === "gpt-6-astra", "thread_model");
  requireCheck(result.modelProvider === "openai", "thread_provider");
  requireCheck(result.approvalPolicy === "never", "thread_approval");
  requireCheck(object(result.sandbox).type === "readOnly"
    && object(result.sandbox).networkAccess === false, "thread_sandbox");
  requireCheck(emptyArray(result.instructionSources), "thread_instructions");
  requireCheck(emptyArray(result.runtimeWorkspaceRoots), "thread_roots");
  requireCheck(typeof thread.id === "string" && thread.id.length > 0, "thread_id");
  return { threadId: thread.id, observedModel: `configured:${result.model}` };
}

type AstraRequest = (method: string, params: unknown) => Promise<unknown>;
async function qualifyThread(request: AstraRequest, cwd: string) {
  const qualified = validateThread(await request("thread/start", {
    model: "gpt-6-astra", modelProvider: "openai", allowProviderModelFallback: false,
    environments: [], ephemeral: true, dynamicTools: [], selectedCapabilityRoots: [], runtimeWorkspaceRoots: [],
    cwd, approvalPolicy: "never", sandbox: "read-only",
  }));
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const inventory = object(await request("mcpServerStatus/list", {
      threadId: qualified.threadId, detail: "full", ...(cursor === undefined ? {} : { cursor }),
    }));
    requireCheck(emptyArray(inventory.data), "inventory");
    if (inventory.nextCursor === null) return qualified;
    requireCheck(typeof inventory.nextCursor === "string" && inventory.nextCursor.length > 0, "inventory_pagination");
    cursor = inventory.nextCursor;
  }
  throw new StartupFailure("inventory_pagination");
}

/** Own all resources across startup, reservation and the turn. */
async function withStartup<T>(
  dependencies: StewardshipAstraSeatDependencies,
  timeoutMs: number,
  ready: (session: StewardshipSeatSession, threadId: string, observedModel: string, cwd: string, startupRemainingMs: number) => Promise<T>,
  markUnavailable: () => void,
): Promise<T> {
  const now = dependencies.now ?? (() => performance.now());
  const started = now();
  const budget = Math.min(timeoutMs, STEWARDSHIP_SEAT_STARTUP_MS);
  const abort = new AbortController();
  let session: StewardshipSeatSession | undefined;
  let directory: ReturnType<typeof temporaryDirectory> | undefined;
  let check: StewardshipAstraStartupCheck = "executable_hash";
  let failed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const remaining = () => {
    const left = budget - (now() - started);
    requireCheck(!abort.signal.aborted && Number.isFinite(left) && left > 0, "startup_timeout");
    return left;
  };
  const startup = async () => {
    remaining();
    const executable = dependencies.executablePath ?? join(STEWARDSHIP_ASTRA_BIN_DIRECTORY, STEWARDSHIP_ASTRA_EXECUTABLE_RELATIVE);
    let hash: string;
    try {
      hash = await (dependencies.readExecutableHash ?? executableHash)(executable, abort.signal);
    } catch (error) {
      if (object(error).code === "ENOENT") throw new StartupFailure("executable_missing");
      throw error;
    }
    remaining();
    requireCheck(hash.toUpperCase() === STEWARDSHIP_ASTRA_PIN.executableSha256, "executable_hash");
    check = "config_scan";
    const codexHome = resolve(dependencies.codexHome ?? STEWARDSHIP_ASTRA_CODEX_HOME);
    await (dependencies.ensureCodexHome ?? (async (path) => { await mkdir(path, { recursive: true }); }))(codexHome);
    remaining();
    let text: string;
    try {
      text = await (dependencies.readConfigText ?? ((path, signal) => readFile(path, { encoding: "utf8", signal })))(join(codexHome, "config.toml"), abort.signal);
    } catch (error) {
      if (object(error).code !== "ENOENT") throw error;
      text = "";
    }
    remaining();
    requireCheck(!text.includes("mcp_servers"), "config_scan");
    check = "session";
    const env = seatEnvironment();
    for (const name of Object.keys(env)) if (/API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(name) || name.toUpperCase() === "CODEX_HOME") delete env[name];
    env.CODEX_HOME = codexHome;
    directory = (dependencies.tempDirFactory ?? temporaryDirectory)();
    remaining();
    const cwd = directory.cwd;
    const overrides = [
      "agents.enabled=false", 'web_search="disabled"', 'forced_login_method="chatgpt"',
      'model_provider="openai"', "analytics.enabled=false", "project_doc_max_bytes=0",
      ...DISABLED_FEATURES.map((name) => `features.${name}=false`),
    ];
    const opened = (dependencies.sessionFactory ?? openStewardshipSeatSession)({
      command: executable, args: [...overrides.flatMap((value) => ["-c", value]), "app-server", "--stdio"], cwd, env,
    });
    let cleanup: Promise<boolean> | undefined;
    session = {
      write: (message) => opened.write(message), next: (timeout) => opened.next(timeout),
      drain: () => opened.drain(), pending: () => opened.pending(),
      close: () => cleanup ??= Promise.resolve().then(() => opened.close()),
    };
    let nextId = 0;
    const request = async (method: string, params: unknown): Promise<unknown> => {
      remaining();
      const id = ++nextId;
      await session!.write({ id, method, params });
      for (let messages = 0; messages < 1000; messages++) {
        const message = object(await session!.next(remaining()));
        checkUsageLimit(message);
        if (allowedNotification(message, "startup")) { remaining(); continue; }
        requireCheck(message.id === id && !Object.hasOwn(message, "method")
          && !Object.hasOwn(message, "error") && Object.hasOwn(message, "result"), "protocol");
        remaining();
        return message.result;
      }
      throw new StartupFailure("protocol");
    };
    check = "version";
    const init = object(await request("initialize", {
      clientInfo: { name: "workflow_tools_roadmap_stewardship", version: "1" }, capabilities: { experimentalApi: true },
    }));
    const versionPattern = new RegExp(`^[^/\\s]+/${STEWARDSHIP_ASTRA_PIN.version.replace(/\./g, "\\.")} `);
    requireCheck(typeof init.userAgent === "string" && versionPattern.test(init.userAgent), "version");
    await session.write({ method: "initialized", params: {} });
    check = "account";
    requireCheck(object(object(await request("account/read", { refreshToken: false })).account).type === "chatgpt", "account");
    check = "protocol";
    validateConfig(await request("config/read", { includeLayers: false, cwd }));
    const qualified = await qualifyThread(async (method, params) => {
      check = method === "mcpServerStatus/list" ? "inventory" : "protocol";
      return request(method, params);
    }, cwd);
    remaining();
    return { session, ...qualified, cwd };
  };
  try {
    let prepared: { session: StewardshipSeatSession; threadId: string; observedModel: string; cwd: string };
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(new StartupFailure("startup_timeout")); }, Math.max(0, budget));
      });
      prepared = await Promise.race([startup(), deadline]);
      remaining();
      requireCheck(await settledTrafficFailure(prepared.session, remaining) === undefined, "protocol");
    } catch (error) {
      markUnavailable();
      if (error instanceof StewardshipUsageLimitError) throw error;
      if (error instanceof StartupFailure) throw error;
      if (abort.signal.aborted || now() - started >= budget
        || (error instanceof StewardshipAssessmentError && error.detail.code === "assessment_timeout")) {
        throw new StartupFailure("startup_timeout");
      }
      throw new StartupFailure(check);
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
    return await ready(prepared.session, prepared.threadId, prepared.observedModel, prepared.cwd, budget - (now() - started));
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    let cleaned = true;
    try { if (session) cleaned = await session.close(); } catch { cleaned = false; }
    // The directory is empty and disposable; a killed Windows child can briefly keep it locked, so a
    // failed removal never replaces the call's real outcome (the same rule as the Claude/GLM seats).
    try { await directory?.remove(); } catch { /* leave it */ }
    if (!cleaned) {
      markUnavailable();
      // In particular, cleanup must never replace the host's reservation refusal.
      if (!failed) throw new StartupFailure("cleanup");
    }
  }
}

const STARTUP_NOTIFICATIONS = new Set([
  "thread/started", "thread/status/changed",
  "account/rateLimits/updated", "remoteControl/status/changed", "warning", "configWarning", "deprecationNotice",
]);
const TURN_NOTIFICATIONS = new Set([
  "turn/started", "turn/completed", "thread/tokenUsage/updated",
  "serverRequest/resolved", "model/safetyBuffering/updated", "item/agentMessage/delta",
  "item/reasoning/summaryTextDelta", "item/reasoning/summaryPartAdded", "item/reasoning/textDelta",
  "item/started", "item/completed",
]);

function checkUsageLimit(message: Record<string, unknown>): void {
  const params = object(message.params);
  const limit = object(params.rateLimits);
  if (message.method === "account/rateLimits/updated"
    && [limit.primary, limit.secondary].some((window) => {
      const usedPercent = object(window).usedPercent;
      return typeof usedPercent === "number" && Number.isFinite(usedPercent) && usedPercent >= 100;
    })) {
    throw new StewardshipUsageLimitError();
  }
  const failure = message.error ?? (message.method === "error" ? params
    : message.method === "turn/completed" ? object(params.turn).error : undefined);
  if (failure !== undefined && isStewardshipUsageLimit(JSON.stringify(failure))) throw new StewardshipUsageLimitError();
}

function allowedNotification(message: Record<string, unknown>, phase: "startup" | "turn"): boolean {
  if (Object.hasOwn(message, "id") || Object.hasOwn(message, "error") || Object.hasOwn(message, "result")
    || typeof message.method !== "string") return false;
  // The live 0.160.0 server announces its loaded login and remote-control state at startup; only the
  // ChatGPT login and a disabled remote control are admissible.
  if (message.method === "account/updated") return object(message.params).authMode === "chatgpt";
  if (message.method === "remoteControl/status/changed") return object(message.params).status === "disabled";
  // Zero configured/inventoried MCP servers means even a disabled-server event is unexpected.
  return STARTUP_NOTIFICATIONS.has(message.method) || (phase === "turn" && TURN_NOTIFICATIONS.has(message.method));
}

/**
 * Classify everything already received before admission. Each drained batch is judged before waiting
 * for a message whose line is still arriving, so a pending line can never delay or mask a violation.
 */
async function settledTrafficFailure(session: StewardshipSeatSession, timeoutMs: () => number,
  finishedThreads: ReadonlySet<string> = new Set(), finishedTurnRequests: ReadonlySet<string> = new Set()): Promise<ReturnType<typeof startupTrafficFailure>> {
  let failure = startupTrafficFailure(session.drain(), finishedThreads, finishedTurnRequests);
  for (let reads = 0; failure === undefined && session.pending(); reads++) {
    if (reads >= 1000) return { code: "runtime_not_tool_free" };
    const next = await session.next(timeoutMs());
    failure = startupTrafficFailure([next, ...session.drain()], finishedThreads, finishedTurnRequests);
  }
  return failure;
}

type TrafficFailure = { readonly code: "tool_event" | "runtime_not_tool_free"; readonly method?: string };
function startupTrafficFailure(messages: readonly unknown[], finishedThreads: ReadonlySet<string> = new Set(),
  finishedTurnRequests: ReadonlySet<string> = new Set()): TrafficFailure | undefined {
  let failure: TrafficFailure | undefined;
  for (const value of messages) {
    const message = object(value);
    checkUsageLimit(message);
    if (finishedThreadTraffic(message, finishedThreads, finishedTurnRequests)) continue;
    if (allowedNotification(message, "startup")) continue;
    if (Object.hasOwn(message, "id") && typeof message.method === "string") failure = { code: "tool_event", method: stewardshipMessageMethod(message) };
    else failure ??= { code: "runtime_not_tool_free", method: stewardshipMessageMethod(message) };
  }
  return failure;
}
const TOOL_ITEMS = new Set([
  "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "webSearch",
  "imageView", "imageGeneration", "functionCallOutput", "sleep", "subAgentActivity",
]);

function finishedThreadTraffic(message: Record<string, unknown>, finishedThreads: ReadonlySet<string>,
  finishedTurnRequests: ReadonlySet<string>): boolean {
  if (typeof message.id === "string" && finishedTurnRequests.has(message.id)
    && !Object.hasOwn(message, "method") && (Object.hasOwn(message, "result") !== Object.hasOwn(message, "error"))) return true;
  const params = object(message.params);
  if (typeof params.threadId !== "string" || !finishedThreads.has(params.threadId)) return false;
  if (message.method === "turn/moderationMetadata") return !["id", "error", "result"].some((key) => Object.hasOwn(message, key))
    && Object.keys(params).length === 3 && ["metadata", "threadId", "turnId"].every((key) => Object.hasOwn(params, key))
    && typeof params.turnId === "string" && params.turnId.length > 0;
  // thread/closed is the pinned protocol's unsubscribe acknowledgement notification.
  if (message.method === "thread/closed") return !Object.hasOwn(message, "id")
    && !Object.hasOwn(message, "error") && !Object.hasOwn(message, "result");
  if (typeof message.method !== "string" || !TURN_NOTIFICATIONS.has(message.method)
    || !allowedNotification(message, "turn")) return false;
  // A previous thread never exempts a tool event or unknown item from fail-closed screening.
  const type = object(params.item).type;
  return !["item/started", "item/completed"].includes(message.method)
    || (typeof type === "string" && ["userMessage", "agentMessage", "reasoning"].includes(type));
}

async function runAstraTurn(
  session: StewardshipSeatSession, threadId: string, observedModel: string, requestId: string,
  prompt: string, timeoutMs: number, dependencies: StewardshipAstraSeatDependencies,
  recordUsage?: (usage: StewardshipIssueUsage["seats"][number]["usage"]) => void,
  keepSession = false,
  finishedThreads: ReadonlySet<string> = new Set(),
  finishedTurnRequests: ReadonlySet<string> = new Set(),
): ReturnType<StewardshipSeat["invoke"]> {
  const error = (code: StewardshipDiagnostic["code"], stage: StewardshipDiagnostic["stage"] = "runtime", method?: string) =>
    new StewardshipAssessmentError({ stage, code, field: "$", ...(method === undefined ? {} : { method }) });
  const now = dependencies.now ?? (() => performance.now());
  const sensitiveValues = dependencies.sensitiveValues ?? [];
  let stopped = false;
  let completedOutput: string | undefined;
  let parsed: Awaited<ReturnType<StewardshipSeat["invoke"]>> | undefined;
  let stage: StewardshipDiagnostic["stage"] = "input";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let usage: StewardshipIssueUsage["seats"][number]["usage"] = "unknown";
  let providerRefusal = false;
  let turnSettled = false;
  let turnId: string | undefined;
  const parseAnswer = (output: string) => {
    const text = output.trim();
    const fenced = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/.exec(text);
    return { assessment: JSON.parse(fenced ? fenced[1] : text), observedModel };
  };
  const close = async () => {
    try { return await session.close(); } catch { return false; }
  };
  const answerClockRequest = async (message: Record<string, unknown>) => {
    if (typeof message.id !== "string" && typeof message.id !== "number") throw error("refused");
    const currentTimeAt = Math.floor((dependencies.utcNow ?? Date.now)() / 1000);
    if (!Number.isSafeInteger(currentTimeAt)) throw error("refused");
    await session.write({ id: message.id, result: { currentTimeAt } });
  };
  const screenTurnMessage = (message: Record<string, unknown>) => {
    checkUsageLimit(message);
    if (typeof message.method !== "string") return;
    if (Object.hasOwn(message, "id")) {
      if (message.method !== "currentTime/read") throw error("tool_event", "runtime", stewardshipMessageMethod(message));
      return;
    }
    if (message.method === "error") return;
    if (!allowedNotification(message, "turn")) throw error("runtime_not_tool_free", "runtime", stewardshipMessageMethod(message));
    if (message.method === "item/started" || message.method === "item/completed") {
      const type = object(object(message.params).item).type;
      if (typeof type !== "string" || !["userMessage", "agentMessage", "reasoning"].includes(type)) {
        throw error(typeof type === "string" && TOOL_ITEMS.has(type) ? "tool_event" : "runtime_not_tool_free", "runtime", stewardshipMessageMethod(message));
      }
    }
  };
  try {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw error("assessment_deadline", "transport");
    stage = "runtime";
    const started = now();
    const remaining = () => {
      const left = timeoutMs - (now() - started);
      if (stopped || !Number.isFinite(left) || left <= 0) throw error("assessment_timeout", "transport");
      return left;
    };
    const turn = async () => {
      await session.write({ id: requestId, method: "turn/start", params: {
        threadId, environments: [], input: [{ type: "text", text: prompt, text_elements: [] }],
      } });
      remaining();
      let acknowledged = false;
      let finalCount = 0;
      let answer: string | undefined;
      let outputBytes = 0;
      let outputFailure: StewardshipAssessmentError | undefined;
      // Snapshots repeat streamed bytes. Charge the larger of deltas and snapshots per item.
      const sizes = new Map<string, { deltas: number; snapshot: number }>();
      const accountText = (id: unknown, text: unknown, delta: boolean) => {
        if (typeof id !== "string" || !id || typeof text !== "string") throw error("refused");
        if (outputFailure) return;
        const size = sizes.get(id) ?? { deltas: 0, snapshot: 0 };
        const previous = Math.max(size.deltas, size.snapshot);
        const bytes = Buffer.byteLength(text);
        if (delta) size.deltas += bytes;
        else size.snapshot = Math.max(size.snapshot, bytes);
        outputBytes += Math.max(size.deltas, size.snapshot) - previous;
        if (outputBytes > ASSESSMENT_OUTPUT_BYTES) {
          outputFailure = error("assessment_output_limit", "transport");
          completedOutput = undefined;
          return;
        }
        sizes.set(id, size);
      };
      const bindTurn = (id: unknown) => {
        if (typeof id !== "string" || !id || (turnId !== undefined && turnId !== id)) throw error("refused");
        turnId = id;
      };
      // Pinned codex-app-server-protocol/ServerNotification.json defines this opaque turn metadata.
      // Metadata is opaque and deliberately ignored; revisit if the pinned protocol gives it typed fields.
      const admitModerationMetadata = (message: Record<string, unknown>): boolean => {
        if (message.method !== "turn/moderationMetadata") return false;
        if (Object.hasOwn(message, "id")) throw error("tool_event", "runtime", stewardshipMessageMethod(message));
        const params = object(message.params);
        if (Object.hasOwn(message, "error") || Object.hasOwn(message, "result") || Object.keys(params).length !== 3
          || !["metadata", "threadId", "turnId"].every((key) => Object.hasOwn(params, key))) {
          throw error("runtime_not_tool_free", "runtime", stewardshipMessageMethod(message));
        }
        if (params.threadId !== threadId) throw error("refused");
        bindTurn(params.turnId);
        return true;
      };
      const tokenUsage = (params: Record<string, unknown>) => {
        if (params.threadId !== threadId || params.turnId !== turnId) return;
        const last = object(object(params.tokenUsage).last);
        const parsedUsage = stewardshipCallUsageSchema.safeParse({ inputTokens: last.inputTokens, cachedInputTokens: last.cachedInputTokens,
          uncachedInputTokens: Number(last.inputTokens) - Number(last.cachedInputTokens), outputTokens: last.outputTokens });
        usage = parsedUsage.success ? parsedUsage.data : "unknown";
      };
      const trailingUsage = async () => {
        let messages = session.drain();
        for (let reads = 0; ; reads++) {
          for (const value of messages) {
            const message = object(value);
            checkUsageLimit(message);
            if (finishedThreadTraffic(message, finishedThreads, finishedTurnRequests)) continue;
            if (admitModerationMetadata(message)) continue;
            if (message.method === "thread/tokenUsage/updated" && allowedNotification(message, "turn")) tokenUsage(object(message.params));
            else {
              const violation = startupTrafficFailure([message], finishedThreads, finishedTurnRequests);
              if (violation) throw error(violation.code, "runtime", violation.method);
            }
          }
          remaining();
          if (!session.pending()) return;
          if (reads >= 1000) throw error("runtime_not_tool_free");
          messages = [await session.next(remaining()), ...session.drain()];
        }
      };
      for (;;) {
        const message = object(await session.next(remaining()));
        // A read can consume the last millisecond; screen its traffic before the deadline check.
        checkUsageLimit(message);
        if (finishedThreadTraffic(message, finishedThreads, finishedTurnRequests)) { remaining(); continue; }
        if (admitModerationMetadata(message)) {
          remaining();
          continue;
        }
        screenTurnMessage(message);
        remaining();
        if (typeof message.method !== "string") {
          if (message.id !== requestId || acknowledged || Object.hasOwn(message, "error") || !Object.hasOwn(message, "result")) throw error("refused");
          bindTurn(object(object(message.result).turn).id);
          acknowledged = true;
          continue;
        }
        if (Object.hasOwn(message, "id")) {
          await answerClockRequest(message);
          remaining();
          continue;
        }
        const params = object(message.params);
        if (message.method === "error") { providerRefusal = true; continue; }
        if (message.method === "thread/tokenUsage/updated") {
          tokenUsage(params);
        } else if (message.method === "item/started" || message.method === "item/completed") {
          const item = object(params.item);
          if (params.threadId !== threadId) throw error("refused");
          bindTurn(params.turnId);
          if (item.type === "agentMessage") {
            accountText(item.id, item.text, false);
            if (message.method === "item/completed" && item.phase !== "commentary") {
              if (item.phase != null && item.phase !== "final_answer") throw error("refused");
              finalCount++;
              answer = item.text as string;
              if (finalCount === 1 && !outputFailure) completedOutput = answer;
            }
          }
        } else if (message.method === "item/agentMessage/delta") {
          if (params.threadId !== threadId) throw error("refused");
          bindTurn(params.turnId);
          accountText(params.itemId, params.delta, true);
        } else if (message.method === "turn/started" || message.method === "turn/completed") {
          if (params.threadId !== threadId) throw error("refused");
          const state = object(params.turn);
          bindTurn(state.id);
          if (message.method === "turn/completed") {
            turnSettled = acknowledged;
            await trailingUsage();
            if (outputFailure) throw outputFailure;
            if (!acknowledged || providerRefusal || state.status !== "completed" || finalCount !== 1 || answer === undefined) throw error("refused");
            return answer;
          }
        }
      }
    };
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { stopped = true; reject(error("assessment_timeout", "transport")); }, timeoutMs);
    });
    completedOutput = await Promise.race([turn(), deadline]);
    stopped = true;
    clearTimeout(timer);
    if (!keepSession && !await close()) throw error("assessment_cleanup_failed", "transport");
    stage = "response_json";
    try { parsed = parseAnswer(completedOutput); }
    catch { throw error("invalid_json", "response_json"); }
    stage = "response_safety";
    assertStewardshipPacketSafe(parsed, sensitiveValues);
    return retainCompletedStewardshipAnswer(parsed, completedOutput, sensitiveValues, parsed);
  } catch (caught) {
    stopped = true;
    clearTimeout(timer);
    // A timeout never retains partial or late output, even if an item had completed.
    const timedOut = caught instanceof StewardshipAssessmentError && caught.detail.code === "assessment_timeout";
    if (timedOut) completedOutput = undefined;
    const securityFailure = caught instanceof StewardshipAssessmentError
      && (caught.detail.code === "tool_event" || caught.detail.code === "runtime_not_tool_free");
    const cleaned = keepSession && turnSettled && !timedOut && !securityFailure
      && !(caught instanceof StewardshipUsageLimitError) ? true : await close();
    if (caught instanceof StewardshipUsageLimitError) throw caught;
    const diagnostic = stewardshipDiagnostic(cleaned || securityFailure ? caught : error("assessment_cleanup_failed", "transport"), "codex", stage);
    const failure = new StewardshipAssessmentError({ stage: diagnostic.stage, code: diagnostic.code, field: diagnostic.field,
      ...(diagnostic.method === undefined ? {} : { method: diagnostic.method }) });
    if (completedOutput !== undefined) {
      // Decode even on a runtime failure so fenced, escaped sensitive values cannot be archived.
      if (!parsed) try { parsed = parseAnswer(completedOutput); } catch { /* Retain safely screened invalid JSON. */ }
      retainCompletedStewardshipAnswer(failure, completedOutput, sensitiveValues, parsed);
    }
    throw failure;
  } finally {
    stopped = true;
    clearTimeout(timer);
    recordUsage?.(usage);
  }
}

export function createStewardshipAstraSeat(dependencies: StewardshipAstraSeatDependencies = {}): StewardshipSeat {
  let unavailable = false;
  let sharedSession = false;
  let prepared: { session: StewardshipSeatSession; cwd: string } | undefined;
  let starting: Promise<void> | undefined;
  let lifetime: Promise<void> | undefined;
  let release: (() => void) | undefined;
  let lifetimeFailure: unknown;
  const finishedThreads = new Set<string>();
  const finishedTurnRequests = new Set<string>();
  let rpcId = 0;
  // Qualification, turns and cleanup all own the same process and notification FIFO.
  let lifecycle = Promise.resolve();
  const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = lifecycle.then(operation);
    lifecycle = result.then(() => {}, () => {});
    return result;
  };
  // A session (re)start or per-thread qualification is budgeted at lock acquisition: the startup cap
  // bounded by the run time the caller still has, so time queued behind a peer's turn can neither
  // starve it nor let it run past the run deadline. Without that callback a (re)start keeps the
  // queue-inclusive budget measured from the call. On the shared session, running out of run time is
  // a deadline, not a seat fault, so it never makes the seat unavailable for the rest of the run;
  // the per-call session of an invoke without start() keeps its fail-closed startup handling.
  const monotonic = dependencies.now ?? (() => performance.now());
  const deadlineError = () => new StewardshipAssessmentError({ stage: "startup", code: "assessment_deadline", field: "$" });
  const startupLeft = (timeoutMs: number, queuedAt: number, runRemainingMs?: () => number) => {
    const left = runRemainingMs ? Math.min(timeoutMs, STEWARDSHIP_SEAT_STARTUP_MS, runRemainingMs()) : timeoutMs - (monotonic() - queuedAt);
    if (!(left > 0)) throw deadlineError();
    return left;
  };
  // A failing callback cannot prove the run is spent, so the caller fails closed.
  const runSpent = (runRemainingMs?: () => number) => {
    try { return runRemainingMs !== undefined && !(runRemainingMs() > 0); } catch { return false; }
  };
  const startupError = (error: unknown) => {
    if (!(error instanceof StartupFailure)) return error;
    return new StewardshipAssessmentError({ stage: error.failedCheck === "cleanup" ? "transport" : "startup",
      code: error.failedCheck === "cleanup" ? "assessment_cleanup_failed" : error.failedCheck === "startup_timeout" ? "seat_startup_timeout" : "seat_unavailable",
      field: "$", check: error.failedCheck });
  };
  const threadDeadline = async <T>(timeoutMs: number, operation: (remaining: () => number) => Promise<T>): Promise<T> => {
    const budget = Math.min(timeoutMs, STEWARDSHIP_SEAT_STARTUP_MS);
    const startedAt = monotonic(); let expired = false;
    const remaining = () => {
      const left = budget - (monotonic() - startedAt);
      requireCheck(!expired && Number.isFinite(left) && left > 0, "startup_timeout");
      return left;
    };
    remaining();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(remaining), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { expired = true; reject(new StartupFailure("startup_timeout")); }, budget);
      })]);
    } finally { expired = true; clearTimeout(timer); }
  };
  const request = (session: StewardshipSeatSession, remaining: () => number, cleanup = false): AstraRequest => async (method, params) => {
    remaining(); const id = `astra-thread-${++rpcId}`;
    await session.write({ id, method, params });
    for (let messages = 0; messages < 1000; messages++) {
      const message = object(await session.next(remaining()));
      checkUsageLimit(message);
      if (finishedThreadTraffic(message, finishedThreads, finishedTurnRequests) || allowedNotification(message, "startup")) { remaining(); continue; }
      if (cleanup && typeof message.method === "string") throw new StewardshipAssessmentError({ stage: "runtime",
        ...(startupTrafficFailure([message], finishedThreads, finishedTurnRequests)
          ?? { code: "runtime_not_tool_free", method: stewardshipMessageMethod(message) }), field: "$" });
      requireCheck(message.id === id && !Object.hasOwn(message, "method")
        && !Object.hasOwn(message, "error") && Object.hasOwn(message, "result"), "protocol");
      remaining(); return message.result;
    }
    throw new StartupFailure("protocol");
  };
  const finishThread = async (session: StewardshipSeatSession, threadId: string, remaining: () => number) => {
    finishedThreads.add(threadId);
    // 0.160.0 supports unsubscribe for ephemeral threads; archiving would persist an issue's data.
    const result = object(await request(session, remaining, true)("thread/unsubscribe", { threadId }));
    requireCheck(typeof result.status === "string" && ["unsubscribed", "notSubscribed", "notLoaded"].includes(result.status), "protocol");
    const violation = await settledTrafficFailure(session, remaining, finishedThreads, finishedTurnRequests);
    if (violation) throw new StewardshipAssessmentError({ stage: "runtime", ...violation, field: "$" });
  };
  const start = (timeoutMs: number): Promise<void> => {
      sharedSession = true;
      if (unavailable) return Promise.reject(new StewardshipAssessmentError({ stage: "startup", code: "seat_unavailable", field: "$" }));
      if (starting) return starting;
      starting = new Promise<void>((accept, reject) => {
        lifetime = withStartup(dependencies, timeoutMs, async (session, threadId, _observedModel, cwd, startupRemainingMs) => {
          finishedThreads.clear();
          finishedTurnRequests.clear();
          // Startup's qualification probe carries no issue data and is never used for assessment.
          await threadDeadline(startupRemainingMs, (remaining) => finishThread(session, threadId, remaining));
          let closed = false;
          prepared = { cwd, session: { ...session,
            close: async () => {
              closed = true; prepared = undefined; starting = undefined;
              release?.();
              const cleaned = await session.close();
              await lifetime;
              if (!cleaned || lifetimeFailure) unavailable = true;
              else { starting = undefined; lifetime = undefined; release = undefined; }
              return cleaned;
            },
            write: (message) => {
              if (closed) throw new StewardshipAssessmentError({ stage: "startup", code: "seat_unavailable", field: "$" });
              return session.write(message);
            } } };
          await new Promise<void>((resolve) => { release = resolve; accept(); });
        }, () => { unavailable = true; }).catch((error: unknown) => {
          unavailable = true;
          lifetimeFailure = startupError(error); reject(lifetimeFailure);
        });
      });
      return starting;
  };
  return {
    family: "codex", requestedModel: "gpt-6-astra", assessmentProtocol: STEWARDSHIP_ASTRA_ASSESSMENT_PROTOCOL,
    // The host starts every seat before each issue's invoke, and its admission gate queues that start
    // behind the previous issue's whole turn. An already-qualified session does no startup work, so
    // only a real (re)start, such as after a peer's turn timed out, needs a startup budget; each
    // thread still requalifies in invoke.
    start: (timeoutMs, runRemainingMs) => {
      const queuedAt = monotonic();
      return exclusive(() => start(prepared ? timeoutMs : startupLeft(timeoutMs, queuedAt, runRemainingMs)));
    },
    close: () => { unavailable = true; return exclusive(async () => {
      release?.(); await lifetime;
      if (lifetimeFailure instanceof StewardshipAssessmentError && lifetimeFailure.detail.code === "assessment_cleanup_failed") throw lifetimeFailure;
    }); },
    invoke({ prompt, startupTimeoutMs, runRemainingMs, reserve, recordUsage }) {
      const qualifiedWhenQueued = prepared !== undefined;
      const queuedAt = monotonic();
      return exclusive(async () => {
        if (unavailable) throw new StewardshipAssessmentError({ stage: "startup", code: "seat_unavailable", field: "$" });
        try { assertStewardshipPacketSafe(prompt, dependencies.sensitiveValues ?? []); }
        catch (error) {
          const diagnostic = stewardshipDiagnostic(error, "codex", "input");
          throw new StewardshipAssessmentError({ stage: diagnostic.stage, code: diagnostic.code, field: diagnostic.field });
        }
        try {
          const turn = async (session: StewardshipSeatSession, threadId: string, observedModel: string, keepSession = prepared !== undefined) => {
            // One absolute deadline from the reservation covers the final settle and the whole turn.
            const clock = dependencies.now ?? (() => performance.now());
            // The host's reservation sets the turn budget from the run deadline at reservation
            // time; time spent queued behind a peer's turn is not charged to this turn.
            const turnTimeoutMs = reserve(); const reservedAt = clock();
            const left = () => turnTimeoutMs - (clock() - reservedAt);
            const expired = () => new StewardshipAssessmentError({ stage: "transport", code: "assessment_deadline", field: "$" });
            let violation: Awaited<ReturnType<typeof settledTrafficFailure>>;
            try {
              violation = await settledTrafficFailure(session, () => {
                const ms = left(); if (!(ms > 0)) throw expired(); return Math.min(5_000, ms);
              }, finishedThreads, finishedTurnRequests);
            } catch (error) {
              if (sharedSession && !await session.close()) throw new StewardshipAssessmentError({ stage: "transport", code: "assessment_cleanup_failed", field: "$" });
              throw error;
            }
            if (violation) {
              unavailable = true;
              if (sharedSession) await session.close();
              throw new StewardshipAssessmentError({ stage: "runtime", ...violation, field: "$" });
            }
            const turnMs = left();
            if (!(turnMs > 0)) {
              if (sharedSession && !await session.close()) throw new StewardshipAssessmentError({ stage: "transport", code: "assessment_cleanup_failed", field: "$" });
              throw expired();
            }
            const requestId = `astra-turn-${++rpcId}`;
            try {
              return await runAstraTurn(session, threadId, observedModel, requestId, prompt, turnMs, dependencies, recordUsage, keepSession, finishedThreads, finishedTurnRequests);
            } finally { finishedTurnRequests.add(requestId); }
          };
          if (sharedSession) {
            if (!prepared) {
              // A queued peer was qualified before the prior turn timed out. Restore
              // its qualification only after that process has confirmed cleanup.
              if (!qualifiedWhenQueued) throw new StewardshipSeatRequalifyRequired();
              await start(startupLeft(startupTimeoutMs, queuedAt, runRemainingMs));
            }
            if (!prepared) throw new StewardshipSeatRequalifyRequired();
            const { session, cwd } = prepared;
            // Per-thread qualification gets a fresh startup budget from lock acquisition: a queued
            // peer always waits behind a full turn, so queue time must not starve qualification.
            // The run time left at acquisition still bounds it when the caller supplies it.
            const qualificationMs = runRemainingMs ? startupLeft(startupTimeoutMs, queuedAt, runRemainingMs) : startupTimeoutMs;
            let qualified: Awaited<ReturnType<typeof qualifyThread>>;
            try {
              qualified = await threadDeadline(qualificationMs, async (remaining) => {
                // Re-qualify EVERY thread: thread sandbox/model/root checks and the empty MCP
                // inventory are per-thread facts, even though session qualification is amortized.
                const thread = await qualifyThread(request(session, remaining), cwd);
                requireCheck(!finishedThreads.has(thread.threadId), "thread_id");
                requireCheck(await settledTrafficFailure(session, remaining, finishedThreads, finishedTurnRequests) === undefined, "protocol");
                return thread;
              });
            } catch (error) {
              // Qualification capped by the run time left that expires with the run is a deadline:
              // close the in-flight thread's session, and keep the seat available only when that
              // close is confirmed, so a later run qualifies afresh.
              if (error instanceof StartupFailure && error.failedCheck === "startup_timeout" && runSpent(runRemainingMs)) {
                let cleaned = false;
                try { cleaned = await session.close(); } catch { /* An unconfirmed close fails closed below. */ }
                if (!cleaned) {
                  unavailable = true;
                  throw new StewardshipAssessmentError({ stage: "transport", code: "assessment_cleanup_failed", field: "$" });
                }
                throw deadlineError();
              }
              // Mid-run thread/start or inventory failure is a startup-stage failure of this
              // invoke and makes the seat unavailable, just like initial qualification failure.
              unavailable = true; await session.close();
              throw error instanceof StartupFailure || error instanceof StewardshipUsageLimitError ? error : new StartupFailure("protocol");
            }
            let failed = false;
            try { return await turn(session, qualified.threadId, qualified.observedModel); }
            catch (error) { failed = true; throw error; }
            finally {
              if (prepared?.session === session) try {
                await threadDeadline(5_000,
                  (remaining) => finishThread(session, qualified.threadId, remaining));
              } catch (error) {
                unavailable = true; await session.close();
                if (error instanceof StewardshipAssessmentError && ["tool_event", "runtime_not_tool_free"].includes(error.detail.code)) throw error;
                if (!failed) throw new StewardshipAssessmentError({ stage: "transport", code: "assessment_cleanup_failed", field: "$" });
              }
            }
          }
          return await withStartup(dependencies, startupLeft(startupTimeoutMs, queuedAt, runRemainingMs), async (session, threadId, observedModel) => {
            finishedThreads.clear(); finishedTurnRequests.clear(); let closed = false; let failed = false;
            const threadSession = { ...session, close: async () => { closed = true; return session.close(); } };
            try { return await turn(threadSession, threadId, observedModel, true); }
            catch (error) { failed = true; throw error; }
            finally {
              if (!closed && !unavailable) try {
                await threadDeadline(5_000,
                  (remaining) => finishThread(threadSession, threadId, remaining));
              } catch (error) {
                unavailable = true;
                if (error instanceof StewardshipAssessmentError && ["tool_event", "runtime_not_tool_free"].includes(error.detail.code)) throw error;
                if (!failed) throw new StewardshipAssessmentError({ stage: "transport", code: "assessment_cleanup_failed", field: "$" });
              }
            }
          }, () => { unavailable = true; });
        } catch (error) {
          if (error instanceof StewardshipAssessmentError && ["tool_event", "runtime_not_tool_free", "assessment_cleanup_failed"].includes(error.detail.code)) unavailable = true;
          throw startupError(error);
        }
      });
    },
  };
}

/** Startup-only preflight: no packet, reservation or model turn. */
export async function checkStewardshipAstraStartup(dependencies: StewardshipAstraSeatDependencies = {}): Promise<
  { readonly ok: true } | { readonly ok: false; readonly failedCheck: StewardshipAstraStartupCheck }
> {
  try {
    return await withStartup(dependencies, dependencies.startupTimeoutMs ?? STEWARDSHIP_SEAT_STARTUP_MS,
      async () => ({ ok: true as const }), () => {});
  } catch (error) {
    return { ok: false, failedCheck: error instanceof StartupFailure ? error.failedCheck : "session" };
  }
}
